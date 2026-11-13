// Text-recognition flow adapted from schappim/macOCR (MIT), Marcus Schappi, 2021.
// Objective-C bridge avoids requiring a Swift runtime/toolchain at installation.
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <EventKit/EventKit.h>
#import <AppKit/AppKit.h>

static void output(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
    if (data) printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    fflush(stdout);
}
static CGKeyCode voiceKey;
static CGEventFlags voiceFlags;
static BOOL voiceHeld = NO;
static CFMachPortRef voiceTap;
static CGEventRef voiceEvent(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *ref) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (voiceHeld) { voiceHeld = NO; output(@{@"event":@"up"}); }
        CGEventTapEnable(voiceTap, true); return event;
    }
    CGEventFlags flags = CGEventGetFlags(event);
    CGKeyCode key = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (voiceHeld && ((type == kCGEventKeyUp && key == voiceKey) || (flags & voiceFlags) != voiceFlags)) {
        voiceHeld = NO; output(@{@"event":@"up"});
    } else if (!voiceHeld && type == kCGEventKeyDown && key == voiceKey &&
               !CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) &&
               (flags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift)) == voiceFlags) {
        voiceHeld = YES; output(@{@"event":@"down"});
    }
    return event;
}
static int watchVoice(int key, unsigned long long flags) {
    voiceKey = key; voiceFlags = flags;
    if (!CGPreflightListenEventAccess() && !CGRequestListenEventAccess()) {
        output(@{@"error":@"请在系统设置 → 隐私与安全性 → 输入监控中允许拾序，然后重新启用快捷键"}); return 1;
    }
    voiceTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
        CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged), voiceEvent, NULL);
    if (!voiceTap) { output(@{@"error":@"无法监听快捷键，请检查输入监控权限后重试"}); return 1; }
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, voiceTap, 0);
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
    CGEventTapEnable(voiceTap, true); output(@{@"event":@"ready"}); CFRunLoopRun();
    CFRelease(source); CFRelease(voiceTap); return 0;
}
static void recognize(NSString *file) {
    NSURL *url = [NSURL fileURLWithPath:file];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) { output(@{@"ok": @NO, @"error": @"image_unreadable"}); return; }
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    CGImagePropertyOrientation orientation = (CGImagePropertyOrientation)([properties[(__bridge NSString *)kCGImagePropertyOrientation] unsignedIntValue] ?: 1);
    CFRelease(source);
    if (!image) { output(@{@"ok": @NO, @"error": @"image_unreadable"}); return; }
    VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.recognitionLanguages = @[@"en-US", @"zh-Hans", @"zh-Hant"];
    request.usesLanguageCorrection = YES;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image orientation:orientation options:@{}];
    NSError *error;
    BOOL success = [handler performRequests:@[request] error:&error];
    CGImageRelease(image);
    if (!success) { output(@{@"ok": @NO, @"error": @"recognition_failed", @"detail": error.localizedDescription ?: @""}); return; }
    NSMutableArray *lines = [NSMutableArray array];
    NSMutableArray *texts = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
        VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
        if (!candidate) continue;
        [texts addObject:candidate.string];
        [lines addObject:@{@"text":candidate.string, @"confidence":@(candidate.confidence)}];
    }
    output(@{@"ok": @YES, @"text": [texts componentsJoinedByString:@"\n"], @"lines": lines});
}
static void readCalendar(EKEventStore *store, NSDate *start, NSDate *end) {
    NSPredicate *predicate = [store predicateForEventsWithStartDate:start endDate:end calendars:nil];
    NSMutableArray *events = [NSMutableArray array];
    for (EKEvent *event in [store eventsMatchingPredicate:predicate]) {
        if (event.availability == EKEventAvailabilityFree) continue;
        [events addObject:@{@"id":event.eventIdentifier ?: @"", @"title":event.title ?: @"日程",
          @"start":@(event.startDate.timeIntervalSince1970 * 1000), @"end":@(event.endDate.timeIntervalSince1970 * 1000),
          @"allDay":@(event.allDay), @"calendar":event.calendar.title ?: @""}];
    }
    output(@{@"ok": @YES, @"events": events});
}
static BOOL calendarHasFullAccess(void) {
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    if (@available(macOS 14.0, *)) return status == EKAuthorizationStatusFullAccess;
    return status == EKAuthorizationStatusAuthorized;
}
static void calendarError(NSString *message) { output(@{@"ok":@NO, @"error":message}); }
static NSString *calendarString(id value) { return [value isKindOfClass:[NSString class]] ? value : @""; }
static EKCalendar *defaultShixuCalendar(EKEventStore *store) {
    for (EKCalendar *calendar in [store calendarsForEntityType:EKEntityTypeEvent]) {
        if (calendar.allowsContentModifications && [calendar.title isEqualToString:@"拾序"]) return calendar;
    }
    NSMutableArray<EKSource *> *sources = [NSMutableArray array];
    if (store.defaultCalendarForNewEvents.source) [sources addObject:store.defaultCalendarForNewEvents.source];
    for (EKSource *source in store.sources) {
        if (![sources containsObject:source] && source.sourceType != EKSourceTypeSubscribed && source.sourceType != EKSourceTypeBirthdays) [sources addObject:source];
    }
    for (EKSource *source in sources) {
        EKCalendar *calendar = [EKCalendar calendarForEntityType:EKEntityTypeEvent eventStore:store];
        calendar.title = @"拾序"; calendar.source = source;
        calendar.color = [NSColor colorWithCalibratedRed:0.2 green:0.55 blue:0.43 alpha:1];
        NSError *error = nil;
        if ([store saveCalendar:calendar commit:YES error:&error]) return calendar;
    }
    return nil;
}
static void calendarCommand(EKEventStore *store, NSDictionary *payload) {
    NSString *action = calendarString(payload[@"action"]);
    if ([action isEqualToString:@"list"]) {
        NSMutableArray *calendars = [NSMutableArray array];
        NSString *suggested = @"";
        for (EKCalendar *calendar in [store calendarsForEntityType:EKEntityTypeEvent]) {
            if (!calendar.allowsContentModifications) continue;
            [calendars addObject:@{@"id":calendar.calendarIdentifier, @"title":calendar.title ?: @"日历", @"source":calendar.source.title ?: @""}];
            if ([calendar.title isEqualToString:@"拾序"]) suggested = calendar.calendarIdentifier;
        }
        output(@{@"ok":@YES, @"calendars":calendars, @"suggestedId":suggested}); return;
    }
    NSString *title = calendarString(payload[@"title"]);
    NSString *marker = calendarString(payload[@"marker"]);
    NSString *eventId = calendarString(payload[@"eventId"]);
    NSString *calendarId = calendarString(payload[@"calendarId"]);
    NSNumber *startValue = payload[@"start"], *endValue = payload[@"end"];
    if (![action isEqualToString:@"save"] || !title.length || title.length > 500 || ![marker hasPrefix:@"shixu://task/"] || marker.length > 512 ||
        ![startValue isKindOfClass:[NSNumber class]] || ![endValue isKindOfClass:[NSNumber class]]) { calendarError(@"calendar_invalid_payload"); return; }
    double start = startValue.doubleValue / 1000, end = endValue.doubleValue / 1000;
    if (!isfinite(start) || !isfinite(end) || start < 978307200 || end > 4133980800 || end <= start || end-start > 366*86400) { calendarError(@"calendar_invalid_payload"); return; }
    EKEvent *event = eventId.length ? [store eventWithIdentifier:eventId] : nil;
    if (event && ![event.URL.absoluteString isEqualToString:marker]) { calendarError(@"calendar_ownership_mismatch"); return; }
    // The event identifier can change after an account sync. Only recover events
    // with our exact marker around persisted dates, never by their title alone.
    if (!event) {
        NSArray *starts = [payload[@"lookupStarts"] isKindOfClass:[NSArray class]] ? payload[@"lookupStarts"] : @[];
        NSMutableDictionary *matches = [NSMutableDictionary dictionary];
        for (id value in starts) {
            if (![value isKindOfClass:[NSNumber class]] || !isfinite([value doubleValue])) continue;
            NSDate *date = [NSDate dateWithTimeIntervalSince1970:[value doubleValue] / 1000];
            NSPredicate *predicate = [store predicateForEventsWithStartDate:[date dateByAddingTimeInterval:-2*86400] endDate:[date dateByAddingTimeInterval:2*86400] calendars:nil];
            for (EKEvent *candidate in [store eventsMatchingPredicate:predicate]) {
                if ([candidate.URL.absoluteString isEqualToString:marker] && candidate.eventIdentifier) matches[candidate.eventIdentifier] = candidate;
            }
        }
        if (matches.count > 1) { calendarError(@"calendar_duplicate_events"); return; }
        event = matches.allValues.firstObject;
        if (!event && eventId.length) { calendarError(@"calendar_event_missing"); return; }
    }
    BOOL updated = event != nil;
    if (event && (!event.calendar.allowsContentModifications || event.hasRecurrenceRules)) { calendarError(@"calendar_not_writable"); return; }
    EKCalendar *calendar = calendarId.length ? [store calendarWithIdentifier:calendarId] : (event ? event.calendar : nil);
    if (calendarId.length && (!calendar || !calendar.allowsContentModifications)) { calendarError(@"calendar_not_writable"); return; }
    if (!calendar) calendar = defaultShixuCalendar(store);
    if (!calendar) { calendarError(@"calendar_unavailable"); return; }
    if (!event) event = [EKEvent eventWithEventStore:store];
    event.calendar = calendar; event.title = title;
    event.startDate = [NSDate dateWithTimeIntervalSince1970:start];
    event.endDate = [NSDate dateWithTimeIntervalSince1970:end];
    event.allDay = [payload[@"allDay"] respondsToSelector:@selector(boolValue)] && [payload[@"allDay"] boolValue];
    event.URL = [NSURL URLWithString:marker];
    NSError *error = nil;
    if (![store saveEvent:event span:EKSpanThisEvent commit:YES error:&error]) { calendarError(@"calendar_write_failed"); return; }
    output(@{@"ok":@YES, @"eventId":event.eventIdentifier ?: @"", @"calendarId":calendar.calendarIdentifier,
      @"calendarTitle":calendar.title ?: @"", @"start":@(event.startDate.timeIntervalSince1970*1000),
      @"end":@(event.endDate.timeIntervalSince1970*1000), @"allDay":@(event.allDay), @"updated":@(updated)});
}
static void runCalendarCommand(void) {
    NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
    if (data.length > 131072) { calendarError(@"calendar_invalid_payload"); return; }
    id payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![payload isKindOfClass:[NSDictionary class]]) { calendarError(@"calendar_invalid_payload"); return; }
    EKEventStore *store = [EKEventStore new];
    if (calendarHasFullAccess()) { calendarCommand(store, payload); return; }
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    BOOL canRequest = status == EKAuthorizationStatusNotDetermined;
    if (@available(macOS 14.0, *)) canRequest = canRequest || status == EKAuthorizationStatusWriteOnly;
    if (!canRequest) { calendarError(@"calendar_permission_denied"); return; }
    void (^completion)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
        if (granted) calendarCommand(store, payload); else calendarError(@"calendar_permission_denied");
        exit(0);
    };
    if (@available(macOS 14.0, *)) [store requestFullAccessToEventsWithCompletion:completion];
    else [store requestAccessToEntityType:EKEntityTypeEvent completion:completion];
    [[NSRunLoop mainRunLoop] run];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "calendar-command") == 0) { runCalendarCommand(); return 0; }
        if (argc == 4 && strcmp(argv[1], "voice-watch") == 0) return watchVoice(atoi(argv[2]), strtoull(argv[3], NULL, 10));
        if (argc >= 3 && strcmp(argv[1], "ocr") == 0) { recognize(@(argv[2])); return 0; }
        if (argc >= 4 && strcmp(argv[1], "calendar") == 0) {
            NSDate *start = [NSDate dateWithTimeIntervalSince1970:atof(argv[2])];
            NSDate *end = [NSDate dateWithTimeIntervalSince1970:atof(argv[3])];
            if ([end timeIntervalSinceDate:start] <= 0 || [end timeIntervalSinceDate:start] > 32 * 86400) { output(@{@"ok": @NO, @"error": @"invalid_range"}); return 0; }
            EKEventStore *store = [EKEventStore new];
            EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
            if (status == EKAuthorizationStatusAuthorized) { readCalendar(store, start, end); return 0; }
            if (@available(macOS 14.0, *)) {
                if (status == EKAuthorizationStatusFullAccess) { readCalendar(store, start, end); return 0; }
            }
            if (status != EKAuthorizationStatusNotDetermined) { output(@{@"ok": @NO, @"error": @"calendar_permission_denied"}); return 0; }
            void (^completion)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
                if (granted) readCalendar(store, start, end);
                else output(@{@"ok": @NO, @"error": @"calendar_permission_denied"});
                exit(0);
            };
            if (@available(macOS 14.0, *)) [store requestFullAccessToEventsWithCompletion:completion];
            else [store requestAccessToEntityType:EKEntityTypeEvent completion:completion];
            [[NSRunLoop mainRunLoop] run];
            return 0;
        }
        output(@{@"ok": @NO, @"error": @"invalid_command"});
    }
    return 0;
}
