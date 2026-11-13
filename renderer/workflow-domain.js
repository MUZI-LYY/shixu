/* Shared, deterministic boundaries for the assistant's two professional workflows. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkflowDomain = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function text(value, max, label, required = false) {
    if (value == null && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label}格式无效`);
    return value.trim();
  }
  function dayString(value) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  function calendarDate(value) {
    if (value == null || value === '') return null;
    const result = text(value, 32, '日期', true);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(result)) throw new Error('日期格式无效');
    const day = new Date(`${result.slice(0, 10)}T12:00:00`);
    if (!Number.isFinite(day.getTime()) || dayString(day) !== result.slice(0, 10)) throw new Error('日期不存在');
    if (result.length > 10 && (!Number.isFinite(new Date(result).getTime()) || +result.slice(11, 13) > 23 || +result.slice(14, 16) > 59)) throw new Error('时间无效');
    return result;
  }
  function duration(value) {
    if (value == null || value === '' || value === 0) return 0;
    if (!Number.isInteger(value) || value < 1 || value > 480) throw new Error('预计耗时应为 1—480 分钟的整数');
    return value;
  }
  function list(value, limit, label) {
    if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}格式无效或数量过多`);
    return value;
  }
  function normalizeTasks(value = []) {
    const ids = new Set();
    return list(value, 300, '待办').map(task => {
      if (!task || typeof task !== 'object') throw new Error('待办格式无效');
      const id = text(task.id, 128, '待办 ID', true);
      if (ids.has(id)) throw new Error('待办 ID 重复');
      ids.add(id);
      return { id, text: text(task.text, 300, '待办标题', true), done: task.done === true,
        deadline: calendarDate(task.deadline || task.date || null), durationMinutes: duration(task.durationMinutes),
        scheduledStart: task.scheduledStart || null, scheduledEnd: task.scheduledEnd || null };
    });
  }
  function source(payload) {
    return { sourceId: text(payload.sourceId || '', 128, '来源 ID'),
      sourceType: ['recording', 'note', 'text'].includes(payload.sourceType) ? payload.sourceType : 'text' };
  }
  function normalizeMeeting(result, payload) {
    if (!result || typeof result !== 'object') throw new Error('会议整理结果格式无效');
    const transcript = text(payload.text, 60000, '会议转写', true);
    const tasks = normalizeTasks(payload.tasks);
    const origin = source(payload);
    const questions = list(result.questions, 30, '待确认问题').map(item => text(item, 1000, '待确认问题', true));
    const actionItems = list(result.actionItems, 40, '会议行动项').map(item => {
      if (!item || typeof item !== 'object') throw new Error('会议行动项格式无效');
      const title = text(item.text, 80, '行动项标题', true);
      const evidence = text(item.evidence, 2000, '原文依据', true);
      if (!transcript.includes(evidence)) throw new Error('行动项原文依据无法在会议记录中找到，请重新整理');
      // A valid date alone is not evidence of a commitment. No date evidence means no deadline.
      const requestedDate = calendarDate(item.date);
      const dateEvidence = text(item.dateEvidence || '', 500, '日期依据');
      const date = requestedDate && dateEvidence && evidence.includes(dateEvidence) ? requestedDate : null;
      const requestedDuration = duration(item.durationMinutes);
      const durationEvidence = text(item.durationEvidence || '', 500, '耗时依据');
      const durationMinutes = requestedDuration && durationEvidence && evidence.includes(durationEvidence) ? requestedDuration : 0;
      const ownerText = text(item.owner || '', 80, '负责人');
      const owner = ownerText && evidence.includes(ownerText) ? ownerText : null;
      if (requestedDate && !date) questions.push(`「${title}」的日期没有原文依据，请确认。`);
      return { text: title, date, durationMinutes, owner, evidence, dateEvidence: date ? dateEvidence : '',
        ...origin, requiresReview: true,
        existingTaskIds: tasks.filter(task => !task.done && task.text.replace(/\s/g, '') === title.replace(/\s/g, '')).map(task => task.id) };
    });
    return { summary: text(result.summary, 8000, '会议摘要', true),
      decisions: list(result.decisions, 30, '会议决定').map(item => text(item, 1500, '会议决定', true)),
      questions: [...new Set(questions)], actionItems, ...origin };
  }
  function timestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      calendarDate(value);
      const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error('日历事件时间无效，无法安全安排');
  }
  function planDay(payload, now = new Date()) {
    const date = calendarDate(payload.date);
    if (!date || date.length !== 10) throw new Error('请选择安排日期');
    const workingStart = text(payload.workingStart || '09:00', 5, '开始时间');
    const workingEnd = text(payload.workingEnd || '18:00', 5, '结束时间');
    const validClock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validClock(workingStart) || !validClock(workingEnd) || workingStart >= workingEnd) throw new Error('工作时段需要在同一天内，结束晚于开始');
    const start = new Date(`${date}T${workingStart}:00`).getTime();
    const end = new Date(`${date}T${workingEnd}:00`).getTime();
    // DST gaps can normalize wall-clock values: do not silently move a user-selected boundary.
    if (new Date(start).getHours() !== +workingStart.slice(0, 2) || new Date(end).getHours() !== +workingEnd.slice(0, 2)) throw new Error('所选时段遇到时区切换，请调整时间');
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error('当前时间无效');
    const tasks = normalizeTasks(payload.tasks);
    const defaultDuration = duration(payload.durationMinutes);
    const events = list(payload.events, 3000, '日历事件');
    const busy = events.map(event => {
      if (!event || typeof event !== 'object') throw new Error('日历事件格式无效');
      const eventStart = timestamp(event.start), eventEnd = timestamp(event.end);
      if (eventEnd <= eventStart) throw new Error('日历事件结束时间无效');
      return { start: eventStart, end: eventEnd };
    }).filter(event => event.end > start && event.start < end);
    const proposals = [], unscheduled = [];
    const explain = (task, reason) => unscheduled.push({ taskId: task.id, text: task.text, reason });
    const deadlineMs = task => !task.deadline ? Infinity : new Date(task.deadline.length === 10 ? `${task.deadline}T23:59:59` : task.deadline).getTime();
    const pending = tasks.filter(task => !task.done).sort((a, b) => deadlineMs(a) - deadlineMs(b));
    for (const task of pending) {
      if (task.scheduledStart || task.scheduledEnd) { explain(task, '已有时间安排，请先确认是否改期'); continue; }
      const minutes = task.durationMinutes || defaultDuration;
      if (!minutes) { explain(task, '请先确认预计耗时'); continue; }
      if (end <= nowMs) { explain(task, '所选工作时段已经过去'); continue; }
      const deadline = deadlineMs(task);
      if (deadline <= nowMs) { explain(task, '待办已逾期，请先确认新的截止日期'); continue; }
      const latestEnd = Math.min(end, deadline);
      let cursor = Math.max(start, Math.ceil(nowMs / 60000) * 60000);
      const length = minutes * 60000;
      busy.sort((a, b) => a.start - b.start);
      for (const event of busy) {
        if (event.end <= cursor) continue;
        if (cursor + length <= event.start) break;
        cursor = Math.max(cursor, event.end);
      }
      if (cursor + length > latestEnd) { explain(task, deadline < end ? '截止时间前没有足够的连续空闲时间，请调整截止日期或安排日期' : '工作时段内没有足够的连续空闲时间'); continue; }
      const proposal = { taskId: task.id, text: task.text, start: cursor, end: cursor + length, durationMinutes: minutes };
      proposals.push(proposal); busy.push({ start: proposal.start, end: proposal.end });
    }
    return { date, workingStart, workingEnd, proposals, unscheduled,
      message: '安排仅为预览；确认保存前会再次检查日历冲突。' };
  }
  return { normalizeMeeting, normalizeTasks, planDay, calendarDate, dayString, source, text };
});
