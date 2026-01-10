import './index.css';

import { IconDotCircle } from '@codexteam/icons';
import { make } from '@editorjs/dom';
import type { API, BlockAPI, BlockTool, ToolConfig, SanitizerConfig } from '@editorjs/editorjs';

export type MilestoneGanttViewMode = 'project' | 'people';

export interface MilestoneGanttUserLabel {
  id: number;
  label: string;
}

export interface MilestoneGanttConfig extends ToolConfig {
  /**
   * 获取当前登录用户（用于首次写入 creator）
   */
  getCurrentUser?: () => MilestoneGanttUserLabel | null;

  /**
   * 通用块查询回调（复用 /api/editor/blocks/query）
   * 说明：
   * - 甘特图会用 type='milestone' 拉取数据
   * - 会传入 context_note_id/context_block_index 以按本块 creator 权限裁剪范围
   */
  queryBlocks?: (params: {
    type: string;
    field?: string;
    q?: string;
    limit?: number;
    offset?: number;
    context_note_id?: number;
    context_block_index?: number;
  }) => Promise<{ items: Array<{ type: string; note_id: number; block_index: number; data: any }> }>;

  /**
   * 从宿主环境提供当前笔记ID（用于把 context_note_id 传给 queryBlocks）
   */
  getCurrentNoteId?: () => number | null;

  /**
   * 从宿主环境提供当前块索引（用于把 context_block_index 传给 queryBlocks）
   */
  getCurrentBlockIndex?: () => number | null;
}

export interface MilestoneGanttData {
  creator?: MilestoneGanttUserLabel;
  viewMode?: MilestoneGanttViewMode;
}

type MilestoneItem = {
  content: string;
  projectName: string;
  people: string[]; // 已归一化的人员数组
  startTime: string; // YYYY-MM-DD
  time: string; // YYYY-MM-DD (end)
  completed: boolean;
  note_id: number;
  block_index: number;
};

function safeUserLabel(v: any): MilestoneGanttUserLabel | null {
  const id = v && typeof v.id !== 'undefined' ? Number(v.id) : NaN;
  const label = v && typeof v.label === 'string' ? v.label.trim() : '';
  if (!Number.isFinite(id) || id <= 0 || !label) return null;
  return { id, label };
}

function htmlToText(v: any): string {
  const s = typeof v === 'string' ? v : '';
  return s
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function splitPeople(txt: string): string[] {
  const s = (txt || '').trim();
  if (!s) return [];
  const parts = s
    .split(/[,\n、;；]+/g)
    .map(x => x.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function isValidYmd(v: string): boolean {
  const s = (v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false;
  if (mo < 1 || mo > 12) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

function keyOfYmd(ymd: string): number | null {
  if (!isValidYmd(ymd)) return null;
  return Number(ymd.replace(/-/g, ''));
}

function ymdFromKey(k: number): string {
  const s = String(k);
  if (s.length !== 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function eachDayKey(minKey: number, maxKey: number): number[] {
  const min = ymdFromKey(minKey);
  const max = ymdFromKey(maxKey);
  if (!min || !max) return [];
  const [y1, m1, d1] = min.split('-').map(Number);
  const [y2, m2, d2] = max.split('-').map(Number);
  const a = new Date(y1, m1 - 1, d1);
  const b = new Date(y2, m2 - 1, d2);
  const out: number[] = [];
  const cur = new Date(a.getTime());
  while (cur.getTime() <= b.getTime()) {
    const y = cur.getFullYear();
    const mo = cur.getMonth() + 1;
    const d = cur.getDate();
    const key = y * 10000 + mo * 100 + d;
    out.push(key);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export default class MilestoneGantt implements BlockTool {
  private api: API;
  private readOnly: boolean;
  private block: BlockAPI;
  private config: MilestoneGanttConfig;
  private data: MilestoneGanttData;

  private wrapper?: HTMLElement;
  private svgEl?: SVGSVGElement;
  private metaEl?: HTMLElement;
  private loadingEl?: HTMLElement;

  static get isReadOnlySupported() {
    return true;
  }

  static get toolbox() {
    return {
      title: 'Milestone Gantt',
      icon: IconDotCircle,
    };
  }

  static get sanitize(): SanitizerConfig {
    return {
      creator: false as any,
      viewMode: false as any,
    };
  }

  constructor({ data, config, api, readOnly, block }: { data: MilestoneGanttData; config?: MilestoneGanttConfig; api: API; readOnly: boolean; block: BlockAPI }) {
    this.api = api;
    this.readOnly = readOnly;
    this.block = block;
    this.config = config || {};

    const creator = safeUserLabel((data as any)?.creator);
    const viewMode: MilestoneGanttViewMode = (data as any)?.viewMode === 'people' ? 'people' : 'project';
    this.data = { creator: creator || undefined, viewMode };

    // 自动写入 creator（仅首次缺失、且可编辑时）
    if (!this.readOnly && !this.data.creator) {
      const me = this.getCurrentUser();
      if (me) this.data.creator = me;
    }
  }

  render(): HTMLElement {
    const wrap = make('div', ['cdx-milestone-gantt']) as HTMLElement;
    this.wrapper = wrap;

    const header = make('div', ['cdx-milestone-gantt__header']) as HTMLElement;
    const title = make('div', ['cdx-milestone-gantt__title']) as HTMLElement;
    title.textContent = this.api.i18n.t('里程碑甘特图');
    header.appendChild(title);

    const spacer = make('div', ['cdx-milestone-gantt__spacer']) as HTMLElement;
    header.appendChild(spacer);

    const btnProject = make('button', ['cdx-milestone-gantt__chip'], { type: 'button' }) as HTMLButtonElement;
    btnProject.textContent = this.api.i18n.t('按项目');
    const btnPeople = make('button', ['cdx-milestone-gantt__chip'], { type: 'button' }) as HTMLButtonElement;
    btnPeople.textContent = this.api.i18n.t('按人员');
    const btnRefresh = make('button', ['cdx-milestone-gantt__chip'], { type: 'button' }) as HTMLButtonElement;
    btnRefresh.textContent = this.api.i18n.t('刷新');

    const applyActive = () => {
      if (this.data.viewMode === 'project') {
        btnProject.classList.add('is-active');
        btnPeople.classList.remove('is-active');
      } else {
        btnPeople.classList.add('is-active');
        btnProject.classList.remove('is-active');
      }
    };
    applyActive();

    btnProject.addEventListener('click', () => {
      this.data.viewMode = 'project';
      applyActive();
      void this.refresh();
    });
    btnPeople.addEventListener('click', () => {
      this.data.viewMode = 'people';
      applyActive();
      void this.refresh();
    });
    btnRefresh.addEventListener('click', () => void this.refresh());

    header.appendChild(btnProject);
    header.appendChild(btnPeople);
    header.appendChild(btnRefresh);
    wrap.appendChild(header);

    const viewport = make('div', ['cdx-milestone-gantt__viewport']) as HTMLElement;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cdx-milestone-gantt__svg');
    svg.setAttribute('viewBox', '0 0 900 260');
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    viewport.appendChild(svg);
    wrap.appendChild(viewport);
    this.svgEl = svg as any;

    const meta = make('div', ['cdx-milestone-gantt__meta']) as HTMLElement;
    this.metaEl = meta;
    wrap.appendChild(meta);

    const loading = make('div', ['cdx-milestone-gantt__hint']) as HTMLElement;
    loading.textContent = this.api.i18n.t('加载中…');
    this.loadingEl = loading;
    wrap.appendChild(loading);

    // 初次渲染拉取数据
    void this.refresh();

    return wrap;
  }

  save(): MilestoneGanttData {
    return {
      creator: this.data.creator,
      viewMode: this.data.viewMode || 'project',
    };
  }

  validate(savedData: MilestoneGanttData): boolean {
    if (!savedData || typeof savedData !== 'object') return false;
    const vm = (savedData as any).viewMode;
    if (vm && vm !== 'project' && vm !== 'people') return false;
    // creator 由后端强校验；前端允许为空（首次插入时会补）
    return true;
  }

  private getCurrentUser(): MilestoneGanttUserLabel | null {
    try {
      const fn = this.config && typeof this.config.getCurrentUser === 'function' ? this.config.getCurrentUser : null;
      const me = fn ? fn() : null;
      return me ? safeUserLabel(me) : null;
    } catch (_) {
      return null;
    }
  }

  private getContextNoteId(): number | null {
    try {
      const v = this.config.getCurrentNoteId ? this.config.getCurrentNoteId() : null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) {
      return null;
    }
  }

  private getContextBlockIndex(): number | null {
    try {
      const v = this.config.getCurrentBlockIndex ? this.config.getCurrentBlockIndex() : null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch (_) {
      return null;
    }
  }

  private setLoading(text: string) {
    if (this.loadingEl) this.loadingEl.textContent = text;
  }

  private async refresh(): Promise<void> {
    if (!this.svgEl) return;
    if (!this.config.queryBlocks) {
      this.setLoading(this.api.i18n.t('未配置 queryBlocks，无法加载数据'));
      this.renderEmptySvg(this.api.i18n.t('未配置数据接口'));
      return;
    }

    const noteId = this.getContextNoteId();
    const blockIndex = this.getContextBlockIndex();
    if (!noteId || blockIndex == null) {
      this.setLoading(this.api.i18n.t('缺少上下文 noteId/blockIndex，无法按 creator 权限查询'));
      this.renderEmptySvg(this.api.i18n.t('缺少上下文'));
      return;
    }

    this.setLoading(this.api.i18n.t('加载中…'));

    const pageSize = 200;
    let offset = 0;
    const all: MilestoneItem[] = [];
    for (let page = 0; page < 50; page++) {
      const resp = await this.config.queryBlocks({
        type: 'milestone',
        limit: pageSize,
        offset,
        context_note_id: noteId,
        context_block_index: blockIndex,
      });
      const items = resp && Array.isArray(resp.items) ? resp.items : [];
      for (const it of items) {
        const d = it && it.data ? it.data : {};
        const start = htmlToText((d as any).startTime || (d as any).time || '');
        const end = htmlToText((d as any).time || (d as any).startTime || '');
        const sk = keyOfYmd(start);
        const ek = keyOfYmd(end);
        if (sk == null || ek == null) continue;
        all.push({
          content: htmlToText((d as any).content || ''),
          projectName: htmlToText((d as any).projectName || ''),
          people: splitPeople(htmlToText((d as any).people || '')),
          startTime: start,
          time: end,
          completed: !!(d as any).completed,
          note_id: Number(it.note_id),
          block_index: Number(it.block_index),
        });
      }
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    this.renderChart(all);
  }

  private renderEmptySvg(text: string) {
    if (!this.svgEl) return;
    while (this.svgEl.firstChild) this.svgEl.removeChild(this.svgEl.firstChild);
    const w = 900;
    const h = 260;
    this.svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', String(16));
    t.setAttribute('y', String(28));
    t.setAttribute('fill', '#64748b');
    t.setAttribute('font-size', '13');
    t.textContent = text;
    this.svgEl.appendChild(t);
  }

  private renderChart(items: MilestoneItem[]) {
    if (!this.svgEl) return;

    if (this.metaEl) {
      const creator = this.data.creator;
      const cLabel = creator && creator.label ? creator.label : this.api.i18n.t('未设置');
      const count = items.length;
      this.metaEl.innerHTML = '';
      const a = make('span', [], { innerHTML: `${this.api.i18n.t('创建人')}: <b>${this.escapeHtml(cLabel)}</b>` });
      const b = make('span', [], { innerHTML: `${this.api.i18n.t('条目')}: <b>${count}</b>` });
      this.metaEl.appendChild(a);
      this.metaEl.appendChild(b);
    }

    if (items.length === 0) {
      this.setLoading(this.api.i18n.t('无 milestone 数据'));
      this.renderEmptySvg(this.api.i18n.t('无数据'));
      return;
    }

    // 计算全局时间范围
    let minKey: number | null = null;
    let maxKey: number | null = null;
    for (const it of items) {
      const s = keyOfYmd(it.startTime);
      const e = keyOfYmd(it.time);
      if (s == null || e == null) continue;
      const a = Math.min(s, e);
      const b = Math.max(s, e);
      minKey = minKey == null ? a : Math.min(minKey, a);
      maxKey = maxKey == null ? b : Math.max(maxKey, b);
    }
    if (minKey == null || maxKey == null) {
      this.setLoading(this.api.i18n.t('日期字段缺失/格式错误'));
      this.renderEmptySvg(this.api.i18n.t('日期无效'));
      return;
    }

    const days = eachDayKey(minKey, maxKey);
    if (days.length === 0) {
      this.setLoading(this.api.i18n.t('日期范围为空'));
      this.renderEmptySvg(this.api.i18n.t('日期范围为空'));
      return;
    }

    // 分组（两种视图）
    type Row = { group: string; label: string; items: MilestoneItem[] };
    const rows: Row[] = [];
    if (this.data.viewMode === 'project') {
      const byProject = new Map<string, MilestoneItem[]>();
      for (const it of items) {
        const key = it.projectName || this.api.i18n.t('未命名项目');
        if (!byProject.has(key)) byProject.set(key, []);
        byProject.get(key)!.push(it);
      }
      const projects = Array.from(byProject.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
      for (const p of projects) {
        const list = byProject.get(p) || [];
        list.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
        for (const it of list) {
          rows.push({ group: p, label: it.content || this.api.i18n.t('（无内容）'), items: [it] });
        }
      }
    } else {
      const byPerson = new Map<string, MilestoneItem[]>();
      for (const it of items) {
        const ps = it.people.length ? it.people : [this.api.i18n.t('未指定人员')];
        for (const p of ps) {
          if (!byPerson.has(p)) byPerson.set(p, []);
          byPerson.get(p)!.push(it);
        }
      }
      const people = Array.from(byPerson.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
      for (const p of people) {
        const list = byPerson.get(p) || [];
        list.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
        for (const it of list) {
          rows.push({ group: p, label: it.content || this.api.i18n.t('（无内容）'), items: [it] });
        }
      }
    }

    // 画布尺寸
    const leftW = 320;
    const topH = 40;
    const rowH = 22;
    const dayW = 18;
    const w = leftW + days.length * dayW + 20;
    const h = topH + rows.length * rowH + 20;
    this.svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);

    while (this.svgEl.firstChild) this.svgEl.removeChild(this.svgEl.firstChild);

    const add = (el: Element) => this.svgEl!.appendChild(el);
    const svgNS = 'http://www.w3.org/2000/svg';

    // 背景
    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(w));
    bg.setAttribute('height', String(h));
    bg.setAttribute('fill', '#ffffff');
    add(bg);

    // 竖向日网格 + 顶部日期标签（只写每隔一段）
    for (let i = 0; i < days.length; i++) {
      const x = leftW + i * dayW;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', String(topH - 6));
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(h - 10));
      line.setAttribute('stroke', 'rgba(2, 132, 199, .10)');
      add(line);

      if (i === 0 || i === days.length - 1 || i % 7 === 0) {
        const t = document.createElementNS(svgNS, 'text');
        t.setAttribute('x', String(x + 2));
        t.setAttribute('y', String(18));
        t.setAttribute('fill', '#64748b');
        t.setAttribute('font-size', '11');
        const ymd = ymdFromKey(days[i]);
        t.textContent = ymd ? ymd.slice(5) : '';
        add(t);
      }
    }

    // 行分隔线
    for (let r = 0; r <= rows.length; r++) {
      const y = topH + r * rowH;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', '0');
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', String(w));
      line.setAttribute('y2', String(y));
      line.setAttribute('stroke', 'rgba(15, 23, 42, .06)');
      add(line);
    }

    // 左侧标签 + 条条
    const dayIndex = new Map<number, number>();
    days.forEach((k, idx) => dayIndex.set(k, idx));

    let lastGroup: string | null = null;
    for (let i = 0; i < rows.length; i++) {
      const yTop = topH + i * rowH;
      const yMid = yTop + rowH / 2 + 4;
      const row = rows[i];

      // group label（每个 group 第一个 row 绘制加粗）
      const isFirstInGroup = row.group !== lastGroup;
      lastGroup = row.group;
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', '12');
      label.setAttribute('y', String(yMid));
      label.setAttribute('fill', isFirstInGroup ? '#0f172a' : '#475569');
      label.setAttribute('font-size', isFirstInGroup ? '12' : '11');
      label.setAttribute('font-weight', isFirstInGroup ? '700' : '400');
      label.textContent = isFirstInGroup ? row.group : '·';
      add(label);

      const sub = document.createElementNS(svgNS, 'text');
      sub.setAttribute('x', '130');
      sub.setAttribute('y', String(yMid));
      sub.setAttribute('fill', '#0f172a');
      sub.setAttribute('font-size', '11');
      sub.textContent = row.label.length > 18 ? `${row.label.slice(0, 18)}…` : row.label;
      add(sub);

      // bar（一个 row 当前只画一个 item）
      const it = row.items[0];
      const sKey = keyOfYmd(it.startTime);
      const eKey = keyOfYmd(it.time);
      if (sKey == null || eKey == null) continue;
      const a = Math.min(sKey, eKey);
      const b = Math.max(sKey, eKey);
      const sx = leftW + (dayIndex.get(a) ?? 0) * dayW;
      const ex = leftW + ((dayIndex.get(b) ?? 0) + 1) * dayW;
      const bar = document.createElementNS(svgNS, 'rect');
      bar.setAttribute('x', String(sx));
      bar.setAttribute('y', String(yTop + 4));
      bar.setAttribute('width', String(Math.max(2, ex - sx)));
      bar.setAttribute('height', String(Math.max(10, rowH - 8)));
      bar.setAttribute('rx', '6');
      bar.setAttribute('fill', it.completed ? '#10b981' : '#0284c7');
      bar.setAttribute('opacity', it.completed ? '0.55' : '0.85');

      const tip = document.createElementNS(svgNS, 'title');
      tip.textContent = `${it.projectName || ''}\n${it.content || ''}\n${it.startTime} ~ ${it.time}\n${it.people.join('、')}`;
      bar.appendChild(tip);
      add(bar);
    }

    this.setLoading(this.api.i18n.t(''));
  }

  private escapeHtml(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

