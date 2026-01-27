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
  projectFilters?: string[]; // 空数组/未设置表示“全部项目”
  peopleFilters?: string[]; // 空数组/未设置表示“全部人员”
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

function safeStringArray(v: any): string[] {
  const arr = Array.isArray(v) ? v : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const s = typeof x === 'string' ? x.trim() : '';
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
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

/**
 * 从 wrapper 元素获取 CSS 变量值（支持主题切换）
 */
function getCssVar(wrapper: HTMLElement | null, varName: string, fallback: string): string {
  if (!wrapper) return fallback;
  try {
    const style = window.getComputedStyle(wrapper);
    const value = style.getPropertyValue(varName).trim();
    return value || fallback;
  } catch (_) {
    return fallback;
  }
}

export default class MilestoneGantt implements BlockTool {
  private api: API;
  private readOnly: boolean;
  private block: BlockAPI;
  private config: MilestoneGanttConfig;
  private data: MilestoneGanttData;

  private wrapper?: HTMLElement;
  private svgLeftEl?: SVGSVGElement;
  private svgRightEl?: SVGSVGElement;
  private timelineViewportEl?: HTMLElement;
  private leftInnerEl?: HTMLElement;
  private metaEl?: HTMLElement;
  private loadingEl?: HTMLElement;

  private projectFilterBtn?: HTMLButtonElement;
  private peopleFilterBtn?: HTMLButtonElement;
  private projectFilterValueEl?: HTMLElement;
  private peopleFilterValueEl?: HTMLElement;

  private filterChooserEl?: HTMLElement;
  private filterChooserTitleEl?: HTMLElement;
  private filterChooserListEl?: HTMLElement;
  private filterChooserMode: 'project' | 'people' | null = null;
  private removeFilterChooserListeners?: () => void;

  private availableProjects: string[] = [];
  private availablePeople: string[] = [];
  private selectedProjectFilters: string[] = []; // 空数组表示“全部项目”
  private selectedPeopleFilters: string[] = []; // 空数组表示“全部人员”

  private dayW = 18;
  private lastItems: MilestoneItem[] = [];
  private rawItems: MilestoneItem[] = [];

  private removePanZoomListeners?: () => void;

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
      projectFilters: false as any,
      peopleFilters: false as any,
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

    // 从数据中恢复筛选（空数组表示全部）
    this.selectedProjectFilters = safeStringArray((data as any)?.projectFilters);
    this.selectedPeopleFilters = safeStringArray((data as any)?.peopleFilters);

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

    // 筛选栏（放在标题右侧）
    const filters = make('div', ['cdx-milestone-gantt__filters']) as HTMLElement;
    const canEdit = this.canEditFilters();

    const buildFilter = (labelText: string) => {
      const row = make('div', ['cdx-milestone-gantt__filter']) as HTMLElement;
      const label = make('span', ['cdx-milestone-gantt__filterLabel']) as HTMLElement;
      label.textContent = labelText;
      const value = make('span', ['cdx-milestone-gantt__filterValue']) as HTMLElement;
      const btn = make('button', ['cdx-milestone-gantt__chip', 'cdx-milestone-gantt__filterBtn'], { type: 'button' }) as HTMLButtonElement;
      btn.textContent = this.api.i18n.t('选择');
      if (!canEdit) {
        btn.disabled = true;
        btn.title = this.api.i18n.t('仅创建者可设置筛选');
      }
      row.appendChild(label);
      row.appendChild(value);
      row.appendChild(btn);
      return { row, value, btn };
    };

    const pf = buildFilter(this.api.i18n.t('项目'));
    this.projectFilterValueEl = pf.value;
    this.projectFilterBtn = pf.btn;
    pf.btn.addEventListener('click', () => this.openFilterChooser('project'));

    const uf = buildFilter(this.api.i18n.t('人员'));
    this.peopleFilterValueEl = uf.value;
    this.peopleFilterBtn = uf.btn;
    uf.btn.addEventListener('click', () => this.openFilterChooser('people'));

    filters.appendChild(pf.row);
    filters.appendChild(uf.row);
    header.appendChild(filters);

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
      if (this.rawItems.length) this.updateChartFromRaw();
      else void this.refresh();
    });
    btnPeople.addEventListener('click', () => {
      this.data.viewMode = 'people';
      applyActive();
      if (this.rawItems.length) this.updateChartFromRaw();
      else void this.refresh();
    });
    btnRefresh.addEventListener('click', () => void this.refresh());

    header.appendChild(btnProject);
    header.appendChild(btnPeople);
    header.appendChild(btnRefresh);
    wrap.appendChild(header);

    // 筛选弹层
    wrap.appendChild(this.buildFilterChooser());

    // 点击块外关闭筛选弹层
    if (this.removeFilterChooserListeners) {
      this.removeFilterChooserListeners();
      this.removeFilterChooserListeners = undefined;
    }
    const onDocPointerDown = (e: PointerEvent) => {
      if (!this.wrapper) return;
      const t = e.target as any;
      if (!t) return;

      // 点击在块外：关闭
      if (!this.wrapper.contains(t)) {
        this.closeFilterChooser();
        return;
      }

      // 点击在弹层内：不处理
      if (this.filterChooserEl && this.filterChooserEl.contains(t)) return;

      // 点击在触发按钮上：不处理（由按钮 click 负责切换）
      if (this.projectFilterBtn && this.projectFilterBtn.contains(t)) return;
      if (this.peopleFilterBtn && this.peopleFilterBtn.contains(t)) return;

      // 点击块内其他区域：关闭
      this.closeFilterChooser();
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    this.removeFilterChooserListeners = () => document.removeEventListener('pointerdown', onDocPointerDown);

    const grid = make('div', ['cdx-milestone-gantt__grid']) as HTMLElement;

    const left = make('div', ['cdx-milestone-gantt__left']) as HTMLElement;
    const leftInner = make('div', ['cdx-milestone-gantt__leftInner']) as HTMLElement;
    const svgLeft = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgLeft.setAttribute('class', 'cdx-milestone-gantt__svg cdx-milestone-gantt__svg--left');
    svgLeft.setAttribute('width', '320');
    svgLeft.setAttribute('height', '260');
    leftInner.appendChild(svgLeft);
    left.appendChild(leftInner);
    this.svgLeftEl = svgLeft as any;
    this.leftInnerEl = leftInner;

    const right = make('div', ['cdx-milestone-gantt__right']) as HTMLElement;
    const timelineViewport = make('div', ['cdx-milestone-gantt__timelineViewport']) as HTMLElement;
    const svgRight = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgRight.setAttribute('class', 'cdx-milestone-gantt__svg cdx-milestone-gantt__svg--right');
    svgRight.setAttribute('width', '600');
    svgRight.setAttribute('height', '260');
    timelineViewport.appendChild(svgRight);
    right.appendChild(timelineViewport);
    this.svgRightEl = svgRight as any;
    this.timelineViewportEl = timelineViewport;

    grid.appendChild(left);
    grid.appendChild(right);
    wrap.appendChild(grid);

    this.installPanZoom();

    const meta = make('div', ['cdx-milestone-gantt__meta']) as HTMLElement;
    this.metaEl = meta;
    wrap.appendChild(meta);

    const loading = make('div', ['cdx-milestone-gantt__hint']) as HTMLElement;
    loading.textContent = this.api.i18n.t('加载中…');
    this.loadingEl = loading;
    wrap.appendChild(loading);

    // 初次渲染拉取数据
    void this.refresh();

    // 初始化筛选显示文案
    this.refreshFilterValueUI();

    return wrap;
  }

  save(): MilestoneGanttData {
    return {
      creator: this.data.creator,
      viewMode: this.data.viewMode || 'project',
      projectFilters: this.selectedProjectFilters.slice(),
      peopleFilters: this.selectedPeopleFilters.slice(),
    };
  }

  validate(savedData: MilestoneGanttData): boolean {
    if (!savedData || typeof savedData !== 'object') return false;
    const vm = (savedData as any).viewMode;
    if (vm && vm !== 'project' && vm !== 'people') return false;
    const pf = (savedData as any).projectFilters;
    const uf = (savedData as any).peopleFilters;
    if (typeof pf !== 'undefined' && !Array.isArray(pf)) return false;
    if (typeof uf !== 'undefined' && !Array.isArray(uf)) return false;
    if (Array.isArray(pf) && pf.some(x => typeof x !== 'string')) return false;
    if (Array.isArray(uf) && uf.some(x => typeof x !== 'string')) return false;
    // creator 由后端强校验；前端允许为空（首次插入时会补）
    return true;
  }

  private canEditFilters(): boolean {
    if (this.readOnly) return false;
    const creator = this.data.creator;
    const me = this.getCurrentUser();
    if (!creator || !me) return false;
    return creator.id === me.id;
  }

  private buildFilterChooser(): HTMLElement {
    const chooser = make('div', ['cdx-milestone-gantt__chooser']) as HTMLElement;
    this.filterChooserEl = chooser;

    const header = make('div', ['cdx-milestone-gantt__chooserHeader']) as HTMLElement;
    const title = make('div', ['cdx-milestone-gantt__chooserTitle']) as HTMLElement;
    title.textContent = this.api.i18n.t('筛选');
    this.filterChooserTitleEl = title;
    const spacer = make('div', ['cdx-milestone-gantt__chooserSpacer']) as HTMLElement;
    const close = make('button', ['cdx-milestone-gantt__chooserClose'], { type: 'button' }) as HTMLButtonElement;
    close.textContent = this.api.i18n.t('关闭');
    close.addEventListener('click', () => this.closeFilterChooser());
    header.appendChild(title);
    header.appendChild(spacer);
    header.appendChild(close);
    chooser.appendChild(header);

    const list = make('div', ['cdx-milestone-gantt__chooserList']) as HTMLElement;
    this.filterChooserListEl = list;
    chooser.appendChild(list);

    return chooser;
  }

  private openFilterChooser(mode: 'project' | 'people') {
    if (!this.filterChooserEl || !this.filterChooserTitleEl || !this.filterChooserListEl) return;
    if (!this.canEditFilters()) return;

    // 再次点击同一模式：关闭
    if (this.filterChooserMode === mode) {
      this.closeFilterChooser();
      return;
    }

    this.filterChooserMode = mode;
    this.filterChooserEl.classList.add('is-open');
    this.filterChooserEl.dataset.mode = mode;
    this.updateFilterBtnStates();

    // 定位到触发按钮下方
    const anchor = mode === 'project' ? this.projectFilterBtn : this.peopleFilterBtn;
    if (anchor && this.wrapper) {
      try {
        const btnRect = anchor.getBoundingClientRect();
        const wrapRect = this.wrapper.getBoundingClientRect();
        const top = Math.max(0, Math.round(btnRect.bottom - wrapRect.top + 8));
        this.filterChooserEl.style.top = `${top}px`;
      } catch (_) {
        this.filterChooserEl.style.top = '';
      }
    }

    this.renderFilterChooser();
  }

  private closeFilterChooser() {
    if (!this.filterChooserEl) return;
    this.filterChooserEl.classList.remove('is-open');
    try { delete (this.filterChooserEl as any).dataset.mode; } catch (_) {}
    this.filterChooserMode = null;
    this.updateFilterBtnStates();
  }

  private updateFilterBtnStates() {
    const isOpen = !!this.filterChooserMode;
    if (this.wrapper) {
      if (isOpen) this.wrapper.classList.add('is-active');
      else this.wrapper.classList.remove('is-active');
    }
    if (this.projectFilterBtn) {
      if (this.filterChooserMode === 'project') this.projectFilterBtn.classList.add('is-active');
      else this.projectFilterBtn.classList.remove('is-active');
    }
    if (this.peopleFilterBtn) {
      if (this.filterChooserMode === 'people') this.peopleFilterBtn.classList.add('is-active');
      else this.peopleFilterBtn.classList.remove('is-active');
    }
  }

  private renderFilterChooser() {
    if (!this.filterChooserTitleEl || !this.filterChooserListEl) return;
    if (!this.filterChooserMode) return;

    const mode = this.filterChooserMode;
    const isProject = mode === 'project';
    const allText = isProject ? this.api.i18n.t('全部项目') : this.api.i18n.t('全部人员');
    const titleText = isProject ? this.api.i18n.t('筛选项目') : this.api.i18n.t('筛选人员');
    this.filterChooserTitleEl.textContent = titleText;

    const values = isProject ? this.availableProjects : this.availablePeople;
    const selected = isProject ? this.selectedProjectFilters : this.selectedPeopleFilters;
    const selectedSet = new Set(selected);

    this.filterChooserListEl.innerHTML = '';

    const makeItem = (text: string, selected: boolean, onClick: () => void) => {
      const item = make('div', ['cdx-milestone-gantt__chooserItem']) as HTMLElement;
      item.textContent = text;
      if (selected) item.classList.add('is-selected');
      item.addEventListener('click', onClick);
      return item;
    };

    // “全部”
    this.filterChooserListEl.appendChild(
      makeItem(allText, selected.length === 0, () => {
        if (!this.canEditFilters()) return;
        if (isProject) this.selectedProjectFilters = [];
        else this.selectedPeopleFilters = [];
        this.persistFiltersToDataIfAllowed();
        this.refreshFilterValueUI();
        this.renderFilterChooser();
        this.updateChartFromRaw();
      })
    );

    for (const v of values) {
      this.filterChooserListEl.appendChild(
        makeItem(v, selectedSet.has(v), () => {
          if (!this.canEditFilters()) return;
          const next = new Set(isProject ? this.selectedProjectFilters : this.selectedPeopleFilters);
          if (next.has(v)) next.delete(v);
          else next.add(v);
          const list = Array.from(next.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
          if (isProject) this.selectedProjectFilters = list;
          else this.selectedPeopleFilters = list;
          this.persistFiltersToDataIfAllowed();
          this.refreshFilterValueUI();
          this.renderFilterChooser();
          this.updateChartFromRaw();
        })
      );
    }
  }

  private persistFiltersToDataIfAllowed() {
    if (!this.canEditFilters()) return;
    this.data.projectFilters = this.selectedProjectFilters.slice();
    this.data.peopleFilters = this.selectedPeopleFilters.slice();
  }

  private refreshFilterValueUI() {
    const fmt = (allText: string, selected: string[]) => {
      if (selected.length === 0) return allText;
      if (selected.length <= 3) return selected.join('、');
      return `${selected.slice(0, 3).join('、')}…(+${selected.length - 3})`;
    };
    if (this.projectFilterValueEl) {
      this.projectFilterValueEl.textContent = fmt(this.api.i18n.t('全部项目'), this.selectedProjectFilters);
      this.projectFilterValueEl.title = this.selectedProjectFilters.length ? this.selectedProjectFilters.join('、') : this.api.i18n.t('全部项目');
    }
    if (this.peopleFilterValueEl) {
      this.peopleFilterValueEl.textContent = fmt(this.api.i18n.t('全部人员'), this.selectedPeopleFilters);
      this.peopleFilterValueEl.title = this.selectedPeopleFilters.length ? this.selectedPeopleFilters.join('、') : this.api.i18n.t('全部人员');
    }
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

  private installPanZoom() {
    // 防止重复绑定
    if (this.removePanZoomListeners) {
      this.removePanZoomListeners();
      this.removePanZoomListeners = undefined;
    }
    if (!this.timelineViewportEl) return;

    const viewport = this.timelineViewportEl;

    // 同步纵向滚动，让左侧行标题对齐
    const onScroll = () => {
      if (!this.leftInnerEl) return;
      const st = viewport.scrollTop;
      this.leftInnerEl.style.transform = `translateY(${-st}px)`;
    };

    let dragging = false;
    let startX = 0;
    let startScrollLeft = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startScrollLeft = viewport.scrollLeft;
      viewport.classList.add('is-dragging');
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch (_) {
        // ignore
      }
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      viewport.scrollLeft = startScrollLeft - dx;
      e.preventDefault();
    };

    const stopDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      viewport.classList.remove('is-dragging');
      try {
        viewport.releasePointerCapture(e.pointerId);
      } catch (_) {
        // ignore
      }
      e.preventDefault();
    };

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

    const onWheel = (e: WheelEvent) => {
      // 滚轮缩放时间线（不移动左侧列）
      if (!this.timelineViewportEl) return;
      if (!this.lastItems || this.lastItems.length === 0) return;
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      // 以鼠标所在位置为缩放锚点：缩放后尽量保持该日期不“跳走”
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const oldDayW = this.dayW;
      const contentX = viewport.scrollLeft + mouseX;
      const dayAtCursor = contentX / oldDayW;

      const factor = e.deltaY < 0 ? 1.12 : 0.88;
      const next = clamp(Math.round(oldDayW * factor), 6, 80);
      if (next === oldDayW) return;

      e.preventDefault();

      this.dayW = next;
      this.renderChart(this.lastItems);

      // 重新渲染后再恢复 scrollLeft
      requestAnimationFrame(() => {
        const newContentX = dayAtCursor * this.dayW;
        viewport.scrollLeft = newContentX - mouseX;
      });
    };

    viewport.addEventListener('scroll', onScroll);
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', stopDrag);
    viewport.addEventListener('pointercancel', stopDrag);
    viewport.addEventListener('wheel', onWheel, { passive: false });

    this.removePanZoomListeners = () => {
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', stopDrag);
      viewport.removeEventListener('pointercancel', stopDrag);
      viewport.removeEventListener('wheel', onWheel as any);
    };
  }

  private async refresh(): Promise<void> {
    if (!this.svgLeftEl || !this.svgRightEl) return;
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

    this.rawItems = all.slice();
    this.rebuildFilterOptions();
    this.updateChartFromRaw();
  }

  private normalizeProjectName(it: MilestoneItem): string {
    return it.projectName || this.api.i18n.t('未命名项目');
  }

  private normalizePeople(it: MilestoneItem): string[] {
    return it.people && it.people.length ? it.people : [this.api.i18n.t('未指定人员')];
  }

  private applyFilters(items: MilestoneItem[]): MilestoneItem[] {
    const pSel = this.selectedProjectFilters;
    const uSel = this.selectedPeopleFilters;
    return items.filter(it => {
      if (pSel.length > 0 && !pSel.includes(this.normalizeProjectName(it))) return false;
      if (uSel.length > 0) {
        const ps = this.normalizePeople(it);
        let ok = false;
        for (const p of ps) {
          if (uSel.includes(p)) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }
      return true;
    });
  }

  private rebuildFilterOptions() {
    const allProjects = new Set<string>();
    const allPeople = new Set<string>();
    for (const it of this.rawItems) {
      allProjects.add(this.normalizeProjectName(it));
      for (const p of this.normalizePeople(it)) allPeople.add(p);
    }

    const projects = Array.from(allProjects).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const people = Array.from(allPeople).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    this.availableProjects = projects;
    this.availablePeople = people;

    // 选项变化后，裁剪掉已经不存在的已选项；如果裁剪后为空则视为“全部”
    const pSet = new Set(projects);
    const uSet = new Set(people);
    this.selectedProjectFilters = this.selectedProjectFilters.filter(x => pSet.has(x));
    this.selectedPeopleFilters = this.selectedPeopleFilters.filter(x => uSet.has(x));

    this.persistFiltersToDataIfAllowed();
    this.refreshFilterValueUI();

    // 如果弹层打开，实时刷新列表
    if (this.filterChooserMode) {
      this.renderFilterChooser();
    }
  }

  private updateChartFromRaw() {
    const filtered = this.applyFilters(this.rawItems);
    if (this.rawItems.length > 0 && filtered.length === 0) {
      this.setLoading(this.api.i18n.t('无匹配数据'));
      this.lastItems = [];
      this.renderEmptySvg(this.api.i18n.t('无匹配数据'));
      // meta（条目数）仍然按 0 展示
      if (this.metaEl) {
        const creator = this.data.creator;
        const cLabel = creator && creator.label ? creator.label : this.api.i18n.t('未设置');
        this.metaEl.innerHTML = '';
        const a = make('span', [], { innerHTML: `${this.api.i18n.t('创建人')}: <b>${this.escapeHtml(cLabel)}</b>` });
        const b = make('span', [], { innerHTML: `${this.api.i18n.t('条目')}: <b>0</b>` });
        this.metaEl.appendChild(a);
        this.metaEl.appendChild(b);
      }
      return;
    }
    this.renderChart(filtered);
  }

  private renderEmptySvg(text: string) {
    if (!this.svgLeftEl || !this.svgRightEl) return;

    const clear = (svg: SVGSVGElement) => {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    };
    clear(this.svgLeftEl);
    clear(this.svgRightEl);

    const wLeft = 320;
    const wRight = 900;
    const h = 260;
    this.svgLeftEl.setAttribute('width', String(wLeft));
    this.svgLeftEl.setAttribute('height', String(h));
    this.svgRightEl.setAttribute('width', String(wRight));
    this.svgRightEl.setAttribute('height', String(h));

    const svgBg = getCssVar(this.wrapper, '--mg-svg-bg', '#ffffff');
    const svgText = getCssVar(this.wrapper, '--mg-svg-text', '#64748b');

    const svgNS = 'http://www.w3.org/2000/svg';
    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(wRight));
    bg.setAttribute('height', String(h));
    bg.setAttribute('fill', svgBg);
    this.svgRightEl.appendChild(bg);

    const t = document.createElementNS(svgNS, 'text');
    t.setAttribute('x', String(16));
    t.setAttribute('y', String(28));
    t.setAttribute('fill', svgText);
    t.setAttribute('font-size', '13');
    t.textContent = text;
    this.svgRightEl.appendChild(t);
  }

  private renderChart(items: MilestoneItem[]) {
    if (!this.svgLeftEl || !this.svgRightEl) return;
    this.lastItems = items.slice();

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
        const key = this.normalizeProjectName(it);
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
        const ps = this.normalizePeople(it);
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
    const dayW = this.dayW;
    const wRight = days.length * dayW + 20;
    const h = topH + rows.length * rowH + 20;
    this.svgLeftEl.setAttribute('width', String(leftW));
    this.svgLeftEl.setAttribute('height', String(h));
    this.svgRightEl.setAttribute('width', String(wRight));
    this.svgRightEl.setAttribute('height', String(h));

    while (this.svgLeftEl.firstChild) this.svgLeftEl.removeChild(this.svgLeftEl.firstChild);
    while (this.svgRightEl.firstChild) this.svgRightEl.removeChild(this.svgRightEl.firstChild);

    const svgNS = 'http://www.w3.org/2000/svg';

    // 获取 CSS 变量（支持主题切换）
    const svgBg = getCssVar(this.wrapper, '--mg-svg-bg', '#ffffff');
    const svgText = getCssVar(this.wrapper, '--mg-svg-text', '#64748b');
    const svgTextPrimary = getCssVar(this.wrapper, '--mg-svg-text-primary', '#0f172a');
    const svgTextSecondary = getCssVar(this.wrapper, '--mg-svg-text-secondary', '#475569');
    const svgLine = getCssVar(this.wrapper, '--mg-svg-line', 'rgba(2, 132, 199, 0.10)');
    const svgSeparator = getCssVar(this.wrapper, '--mg-svg-separator', 'rgba(15, 23, 42, 0.08)');
    const svgGrid = getCssVar(this.wrapper, '--mg-svg-grid', 'rgba(15, 23, 42, 0.06)');
    const svgWeekend = getCssVar(this.wrapper, '--mg-svg-weekend', 'rgba(148, 163, 184, 0.14)');
    const svgToday = getCssVar(this.wrapper, '--mg-svg-today', 'rgba(250, 204, 21, 0.22)');
    const svgBarCompleted = getCssVar(this.wrapper, '--mg-svg-bar-completed', '#10b981');
    const svgBarActive = getCssVar(this.wrapper, '--mg-svg-bar-active', '#0284c7');

    const addLeft = (el: Element) => this.svgLeftEl!.appendChild(el);
    const addRight = (el: Element) => this.svgRightEl!.appendChild(el);

    // 背景
    const bgLeft = document.createElementNS(svgNS, 'rect');
    bgLeft.setAttribute('x', '0');
    bgLeft.setAttribute('y', '0');
    bgLeft.setAttribute('width', String(leftW));
    bgLeft.setAttribute('height', String(h));
    bgLeft.setAttribute('fill', svgBg);
    addLeft(bgLeft);

    const bgRight = document.createElementNS(svgNS, 'rect');
    bgRight.setAttribute('x', '0');
    bgRight.setAttribute('y', '0');
    bgRight.setAttribute('width', String(wRight));
    bgRight.setAttribute('height', String(h));
    bgRight.setAttribute('fill', svgBg);
    addRight(bgRight);

    // 周末底色（周六/周日列淡色背景，用于区分工作日）
    // 注意：先画背景，再画网格线/条形，避免遮挡内容
    for (let i = 0; i < days.length; i++) {
      const ymd = ymdFromKey(days[i]);
      if (!ymd) continue;
      const [yy, mm, dd] = ymd.split('-').map(Number);
      const dow = new Date(yy, mm - 1, dd).getDay(); // 0=Sun ... 6=Sat
      if (dow !== 0 && dow !== 6) continue;

      const x = i * dayW;
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', '0');
      rect.setAttribute('width', String(dayW));
      rect.setAttribute('height', String(h));
      rect.setAttribute('fill', weekendFill);
      addRight(rect);
    }

    // 当前日期指示：对“今天所在列”增加背景色
    const now = new Date();
    const todayKey = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const todayIdx = days.indexOf(todayKey);
    if (todayIdx >= 0) {
      const x = todayIdx * dayW;
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', '0');
      rect.setAttribute('width', String(dayW));
      rect.setAttribute('height', String(h));
      rect.setAttribute('fill', 'rgba(250, 204, 21, .22)'); // 轻微高亮
      addRight(rect);
    }

    // 左右分隔线
    const sep = document.createElementNS(svgNS, 'line');
    sep.setAttribute('x1', String(leftW - 0.5));
    sep.setAttribute('y1', '0');
    sep.setAttribute('x2', String(leftW - 0.5));
    sep.setAttribute('y2', String(h));
    sep.setAttribute('stroke', 'rgba(15, 23, 42, .08)');
    addLeft(sep);

    // 左侧表头（项目/人员 + 内容）
    const headerA = document.createElementNS(svgNS, 'text');
    headerA.setAttribute('x', '12');
    headerA.setAttribute('y', '18');
    headerA.setAttribute('fill', '#64748b');
    headerA.setAttribute('font-size', '11');
    headerA.setAttribute('font-weight', '600');
    headerA.textContent = this.data.viewMode === 'people' ? this.api.i18n.t('人员') : this.api.i18n.t('项目');
    addLeft(headerA);

    const headerB = document.createElementNS(svgNS, 'text');
    headerB.setAttribute('x', '130');
    headerB.setAttribute('y', '18');
    headerB.setAttribute('fill', '#64748b');
    headerB.setAttribute('font-size', '11');
    headerB.setAttribute('font-weight', '600');
    headerB.textContent = this.api.i18n.t('内容');
    addLeft(headerB);

    // 竖向日网格 + 顶部日期标签（只写每隔一段）
    for (let i = 0; i < days.length; i++) {
      const x = i * dayW;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', String(topH - 6));
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(h - 10));
      line.setAttribute('stroke', 'rgba(2, 132, 199, .10)');
      addRight(line);

      if (i === 0 || i === days.length - 1 || i % 7 === 0) {
        const t = document.createElementNS(svgNS, 'text');
        t.setAttribute('x', String(x + 2));
        t.setAttribute('y', String(18));
        t.setAttribute('fill', '#64748b');
        t.setAttribute('font-size', '11');
        const ymd = ymdFromKey(days[i]);
        t.textContent = ymd ? ymd.slice(5) : '';
        addRight(t);
      }
    }

    // 行分隔线
    for (let r = 0; r <= rows.length; r++) {
      const y = topH + r * rowH;
      const lineL = document.createElementNS(svgNS, 'line');
      lineL.setAttribute('x1', '0');
      lineL.setAttribute('y1', String(y));
      lineL.setAttribute('x2', String(leftW));
      lineL.setAttribute('y2', String(y));
      lineL.setAttribute('stroke', 'rgba(15, 23, 42, .06)');
      addLeft(lineL);

      const lineR = document.createElementNS(svgNS, 'line');
      lineR.setAttribute('x1', '0');
      lineR.setAttribute('y1', String(y));
      lineR.setAttribute('x2', String(wRight));
      lineR.setAttribute('y2', String(y));
      lineR.setAttribute('stroke', 'rgba(15, 23, 42, .06)');
      addRight(lineR);
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
      addLeft(label);

      const sub = document.createElementNS(svgNS, 'text');
      sub.setAttribute('x', '130');
      sub.setAttribute('y', String(yMid));
      sub.setAttribute('fill', '#0f172a');
      sub.setAttribute('font-size', '11');
      sub.textContent = row.label.length > 18 ? `${row.label.slice(0, 18)}…` : row.label;
      addLeft(sub);

      // bar（一个 row 当前只画一个 item）
      const it = row.items[0];
      const sKey = keyOfYmd(it.startTime);
      const eKey = keyOfYmd(it.time);
      if (sKey == null || eKey == null) continue;
      const a = Math.min(sKey, eKey);
      const b = Math.max(sKey, eKey);
      const sx = (dayIndex.get(a) ?? 0) * dayW;
      const ex = ((dayIndex.get(b) ?? 0) + 1) * dayW;
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
      addRight(bar);
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

  destroy() {
    // 清理文档级事件监听，避免内存泄漏
    if (this.removePanZoomListeners) {
      this.removePanZoomListeners();
      this.removePanZoomListeners = undefined;
    }
    if (this.removeFilterChooserListeners) {
      this.removeFilterChooserListeners();
      this.removeFilterChooserListeners = undefined;
    }
  }
}

