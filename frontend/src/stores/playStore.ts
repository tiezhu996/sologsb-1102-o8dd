/**
 * 剧目状态管理（Zustand）
 * 维护剧目列表与当前剧目；所有写操作同步落 IndexedDB。
 */
import { create } from 'zustand';
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  getPlay,
  listPlays,
  listScenesByPlay,
  putPlay,
  putScene,
  removePlay,
  exportSnapshot,
  importSnapshot,
  resetDatabase,
  type DatabaseSnapshot,
  type PlayRow,
  type SceneRow,
} from '../utils/db';
import type { PlayDraft, PlayGenre, PlayStatus } from '../types/play';
import { nowIso, uuid } from '../utils/uuid';
import { STORAGE_KEYS, readLocal, writeLocal } from '../utils/localStore';

/** 新建剧目时自动生成的场次数量（拆场次入口的首场模板） */
export const DEFAULT_FIRST_SCENE_COUNT = 1;

export interface PlayFilters {
  genre: PlayGenre | 'all';
  status: PlayStatus | 'all';
  keyword: string;
}

/** 单剧目的派生统计（场次数 / 平均排练成熟度），供剧目库与操耍人档复用 */
export interface PlayStat {
  playId: string;
  sceneCount: number;
  /** 各场 progress 的平均值，四舍五入 */
  averageProgress: number;
  /** 合计时长（分钟） */
  totalMinute: number;
}

interface PlayStoreState {
  plays: PlayRow[];
  currentPlayId: string | null;
  loading: boolean;
  error: string;
  filters: PlayFilters;
  counts: Record<string, number>;
  playStats: Record<string, PlayStat>;
  loadPlays: () => Promise<void>;
  selectPlay: (playId: string | null) => void;
  createPlay: (draft: PlayDraft) => Promise<PlayRow>;
  updatePlay: (playId: string, patch: Partial<Omit<PlayRow, 'id' | 'createdAt' | 'revision'>>) => Promise<void>;
  deletePlay: (playId: string) => Promise<void>;
  syncSceneCount: (playId: string) => Promise<void>;
  setFilters: (patch: Partial<PlayFilters>) => void;
  resetFilters: () => void;
  visiblePlays: () => PlayRow[];
  statOf: (playId: string) => PlayStat;
  refreshCounts: () => Promise<void>;
  exportAll: () => Promise<DatabaseSnapshot>;
  importAll: (snapshot: DatabaseSnapshot) => Promise<void>;
  resetAll: () => Promise<void>;
}

const EMPTY_FILTERS: PlayFilters = { genre: 'all', status: 'all', keyword: '' };

export const usePlayStore = create<PlayStoreState>((set, get) => ({
  plays: [],
  currentPlayId: readLocal(STORAGE_KEYS.lastPlayId, '') || null,
  loading: false,
  error: '',
  filters: { ...EMPTY_FILTERS },
  counts: {},
  playStats: {},

  async loadPlays() {
    set({ loading: true, error: '' });
    try {
      const plays = await listPlays();
      const current = get().currentPlayId;
      const stillExists = current !== null && plays.some((play) => play.id === current);
      const statEntries = await Promise.all(
        plays.map(async (play): Promise<[string, PlayStat]> => {
          const scenes = await listScenesByPlay(play.id);
          const totalMinute = scenes.reduce(
            (acc, scene) => acc + (Number.isFinite(scene.durationMin) ? scene.durationMin : 0),
            0,
          );
          const averageProgress =
            scenes.length === 0
              ? 0
              : Math.round(scenes.reduce((acc, scene) => acc + scene.progress, 0) / scenes.length);
          return [play.id, { playId: play.id, sceneCount: scenes.length, averageProgress, totalMinute }];
        }),
      );
      set({ plays, loading: false, playStats: Object.fromEntries(statEntries) });
      if (!stillExists) {
        get().selectPlay(plays.length > 0 ? plays[0].id : null);
      }
      await get().refreshCounts();
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '剧目读取失败' });
    }
  },

  selectPlay(playId) {
    set({ currentPlayId: playId });
    writeLocal(STORAGE_KEYS.lastPlayId, playId ?? '');
  },

  async createPlay(draft) {
    const stamp = nowIso();
    const playId = uuid();
    const row: PlayRow = {
      id: playId,
      title: draft.title.trim() || '未命名剧目',
      genre: draft.genre,
      scriptText: draft.scriptText.trim(),
      totalScenes: DEFAULT_FIRST_SCENE_COUNT,
      premiereVenue: draft.premiereVenue.trim(),
      status: draft.status,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putPlay(row);
    // 新建剧目后自动生成「第一场」骨架，场次拆分入口开箱即用
    const firstScene: SceneRow = {
      id: uuid(),
      playId,
      seq: 1,
      title: '第一场·待命名',
      durationMin: 12,
      stageNote: '在此填写影窗、影件更换与走位提示',
      needsShadowScreen: 'standard',
      progress: 0,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putScene(firstScene);
    await get().loadPlays();
    get().selectPlay(playId);
    return row;
  },

  async updatePlay(playId, patch) {
    const existing = await getPlay(playId);
    if (!existing) return;
    const next: PlayRow = { ...existing, ...patch, updatedAt: nowIso(), revision: ROW_REVISION };
    await putPlay(next);
    await get().loadPlays();
  },

  async deletePlay(playId) {
    await removePlay(playId);
    if (get().currentPlayId === playId) get().selectPlay(null);
    await get().loadPlays();
  },

  async syncSceneCount(playId) {
    const scenes = await listScenesByPlay(playId);
    const existing = await getPlay(playId);
    if (!existing) return;
    if (existing.totalScenes === scenes.length) return;
    await putPlay({ ...existing, totalScenes: scenes.length, updatedAt: nowIso(), revision: ROW_REVISION });
    await get().loadPlays();
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS } });
  },

  visiblePlays() {
    const { plays, filters } = get();
    const keyword = filters.keyword.trim().toLowerCase();
    return plays.filter((play) => {
      if (filters.genre !== 'all' && play.genre !== filters.genre) return false;
      if (filters.status !== 'all' && play.status !== filters.status) return false;
      if (keyword === '') return true;
      return (
        play.title.toLowerCase().includes(keyword) ||
        play.scriptText.toLowerCase().includes(keyword) ||
        play.premiereVenue.toLowerCase().includes(keyword)
      );
    });
  },

  statOf(playId) {
    return get().playStats[playId] ?? { playId, sceneCount: 0, averageProgress: 0, totalMinute: 0 };
  },

  async refreshCounts() {
    const counts = await countAll();
    set({ counts: { ...counts, schemaVersion: DB_SCHEMA_VERSION } });
  },

  async exportAll() {
    return exportSnapshot();
  },

  async importAll(snapshot) {
    await importSnapshot(snapshot);
    await get().loadPlays();
  },

  async resetAll() {
    await resetDatabase();
    get().selectPlay(null);
    await get().loadPlays();
  },
}));
