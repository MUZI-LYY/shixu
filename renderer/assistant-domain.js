/* Task extraction adapted from v2do (MIT). Shared validation runs for every provider. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VoiceDomain = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ACTIONS = ['create', 'update', 'complete', 'query'];
  function dayString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function number(text) {
    if (/^\d+$/.test(text)) return Number(text);
    const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (text === '十') return 10;
    if (text.includes('十')) { const [a, b] = text.split('十'); return (digits[a] || 1) * 10 + (digits[b] || 0); }
    return digits[text];
  }
  function parseTime(text, now = new Date()) {
    let date = new Date(now);
    let matched = '';
    const relative = text.match(/大后天|后天|明天|今天/);
    const weekday = text.match(/(下|本|这)?(?:周|星期)([一二三四五六日天])/);
    const absolute = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (relative) { date.setDate(date.getDate() + ({ 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[relative[0]])); matched = relative[0]; }
    else if (absolute) { date = new Date(`${absolute[1]}T12:00:00`); matched = absolute[0]; }
    else if (weekday) {
      const target = '一二三四五六日'.indexOf(weekday[2] === '天' ? '日' : weekday[2]);
      const current = (date.getDay() + 6) % 7;
      let delta = target - current;
      if (weekday[1] === '下') delta += 7;
      else if (!weekday[1] && delta < 0) delta += 7;
      date.setDate(date.getDate() + delta); matched = weekday[0];
    }
    const clock = text.match(/(凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*([零一二两三四五六七八九十\d]{1,3})(?:点|:|：)(半|[零一二三四五六七八九十\d]{1,3}分?)?/);
    let rest = text.replace(matched, '');
    if (clock) {
      let hour = number(clock[2]);
      const minute = clock[3] === '半' ? 30 : number((clock[3] || '0').replace('分', ''));
      if (['下午', '晚上', '傍晚'].includes(clock[1]) && hour < 12) hour += 12;
      if (clock[1] === '中午' && hour < 11) hour += 12;
      if (hour > 23 || minute > 59 || hour === undefined || minute === undefined) return { date: null, rest: text, invalid: true };
      date.setHours(hour, minute, 0, 0); rest = rest.replace(clock[0], '');
      return { date: `${dayString(date)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, precision: 'time', rest };
    }
    return { date: matched ? dayString(date) : null, precision: matched ? 'day' : 'none', rest };
  }
  function validateDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(text)) throw new Error('日期格式异常，请明确日期后重试');
    const parsed = new Date(text.length === 10 ? `${text}T12:00:00` : text);
    if (!Number.isFinite(parsed.getTime())) throw new Error('日期无效');
    const calendarDay = new Date(`${text.slice(0, 10)}T12:00:00`);
    if (dayString(calendarDay) !== text.slice(0, 10)) throw new Error('日期不存在');
    const clock = text.match(/T(\d{2}):(\d{2})/);
    if (clock && (Number(clock[1]) > 23 || Number(clock[2]) > 59)) throw new Error('时间无效');
    return text;
  }
  function normalizePlan(plan) {
    if (!plan || !Array.isArray(plan.operations) || plan.operations.length > 20) throw new Error('模型返回格式异常，请重新表达');
    return {
      message: String(plan.message || '').slice(0, 400),
      operations: plan.operations.map(op => {
        if (!op || !ACTIONS.includes(op.action)) throw new Error('操作类型不支持');
        const text = String(op.text || '').trim();
        if (text.length > 80) throw new Error('待办标题超过 80 字，请精简');
        if (op.action === 'create' && !text) throw new Error('缺少待办标题');
        return { action: op.action, text, target: String(op.target || '').trim().slice(0, 128), date: validateDate(op.date),
          category: ['P0', 'P1', 'P2', 'P3'].includes(op.category) ? op.category : 'P3',
          durationMinutes: Math.min(480, Math.max(0, Number(op.durationMinutes) || 0)),
          needsSlot: op.needsSlot === true, period: ['morning', 'afternoon', 'evening'].includes(op.period) ? op.period : 'afternoon',
          question: String(op.question || '').slice(0, 300) };
      }),
    };
  }
  function localPlan(input, now = new Date()) {
    if (/(不是|不对|别|不要|取消|删除|每周|每天|每月)/.test(input)) return { message: '这句话包含纠正、否定或重复规则，请配置模型处理，或拆成明确指令。', operations: [] };
    const clauses = input.split(/[，,。；;\n]|另外|然后|以及/).map(s => s.trim()).filter(Boolean);
    const operations = clauses.map(clause => {
      if (/^(查看|查询|看看|列出)|有哪些|有什么|还剩|[?？]/.test(clause)) return { action: 'query', target: '', text: '' };
      const time = parseTime(clause, now);
      if (time.invalid) return { action: 'query', question: '时间无法识别，请写出明确的小时和分钟。' };
      const complete = clause.match(/^(.+?)(?:已经|已)?(?:交了|做完了|完成了|完成|办好了|搞定了|搞定)$/);
      if (complete) return { action: 'complete', target: complete[1].replace(/^(把|将)/, ''), text: '' };
      const update = clause.match(/^(?:把|将)?(.+?)(?:改到|改成|挪到|移到|推迟到)(.+)$/);
      if (update) return { action: 'update', target: update[1], text: '', date: time.date, question: time.date ? '' : '请补充明确的日期或时间。' };
      const duration = clause.match(/([一二两三四五六七八九十\d]+)(个)?小时|([\d]+)分钟/);
      const needsSlot = /找|安排/.test(clause) && Boolean(duration);
      const durationMinutes = duration ? (duration[3] ? Number(duration[3]) : number(duration[1]) * 60) : 0;
      const period = /上午|早上/.test(clause) ? 'morning' : /晚上|傍晚/.test(clause) ? 'evening' : 'afternoon';
      let text = time.rest.replace(/^(请|帮我|提醒我|记一下|记得|新增|添加|我要|我想)\s*/g, '').replace(/^(请|帮我|提醒我|记一下|记得)\s*/g, '').trim();
      if (needsSlot) text = text.replace(duration[0], '').replace(/找|安排|上午|下午|晚上|早上|傍晚|一个|时间|去/g, '').trim();
      if (!needsSlot && /下午|上午|晚上|早上|傍晚|下周|下个月|月底|小时后|分钟后|今天内/.test(text)) {
        return { action: 'query', question: '这个时间表达需要进一步理解，请补充具体时间或配置模型。' };
      }
      if (!text) return { action: 'query', question: '请补充要做的事情。' };
      return { action: 'create', text, date: time.date, category: 'P3', needsSlot, period, durationMinutes };
    });
    return normalizePlan({ operations, message: '基础解析 · 请检查操作后执行' });
  }
  function matchTasks(target, tasks, recentIds = []) {
    const active = tasks.filter(task => !task.done);
    if (/^(刚才那个|刚才的|这个|它|上一个)$/.test(target)) return active.filter(task => recentIds.includes(task.id));
    const exactId = active.filter(task => task.id === target);
    if (exactId.length) return exactId;
    const clean = text => String(text).replace(/[\s，。！？、]/g, '');
    const term = clean(target);
    if (!term) return [];
    const exact = active.filter(task => clean(task.text) === term);
    return exact.length ? exact : active.filter(task => clean(task.text).includes(term));
  }
  function deadlineFields(date) {
    if (!date) return { deadline: '', datePrecision: 'none' };
    const value = validateDate(date);
    return { deadline: new Date(value.length === 10 ? `${value}T23:59:00` : value).toISOString(), datePrecision: value.length === 10 ? 'day' : 'time' };
  }
  function findSlots(day, durationMinutes, events, tasks, period = 'afternoon', now = Date.now()) {
    const date = new Date(`${String(day).slice(0, 10)}T00:00:00`);
    if (!Number.isFinite(date.getTime())) return [];
    const [from, to] = { morning: [8, 12], afternoon: [13, 18], evening: [18, 22] }[period];
    const busy = [...events.map(event => [event.start, event.end]), ...tasks.filter(task => !task.done && task.durationMinutes && task.deadline).map(task => [Date.parse(task.deadline), Date.parse(task.deadline) + task.durationMinutes * 60000])];
    const slots = [];
    for (let minute = from * 60; minute + durationMinutes <= to * 60; minute += 30) {
      const start = new Date(date); start.setMinutes(minute);
      const end = start.getTime() + durationMinutes * 60000;
      if (start.getTime() <= now || busy.some(([a, b]) => a < end && b > start.getTime())) continue;
      slots.push(`${dayString(start)}T${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`);
      if (slots.length === 4) break;
    }
    return slots;
  }
  return { normalizePlan, localPlan, matchTasks, deadlineFields, findSlots, dayString, parseTime };
});
