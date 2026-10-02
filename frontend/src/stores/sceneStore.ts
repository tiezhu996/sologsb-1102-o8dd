/**
 * 场次状态管理（Zustand）
 * 维护当前剧目的场次顺序、本次排练勾选集与单场排练进度。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  listScenesByPlay,
  putScene,
  putScenes,
  removeScene,
  type SceneRow,
} from '../utils/db';
import type { SceneDraft } from '../types/scene';
import { clampProgress } from '../utils/timecode';
import { nowIso, uuid } from '../utils/uuid';
import { STORAGE_KEYS, readLocalFlag, writeLocalFlag } from '../utils/localStore';

interface SceneStoreState {
  scenes: SceneRow[];
  activePlayId: string | null;
  selectedSceneIds: string[];
  onlySelected: boolean;
  loading: boolean;
  error: string;
  loadScenes: (playId: string) => Promise<void>;
  clearScenes: () => void;
  createScene: (playId: string, draft: SceneDraft) => Promise<SceneRow>;
  createSceneFromPrevious: (playId: string, previous: SceneRow | undefined) => Promise<SceneRow>;
  updateScene: (sceneId: string, patch: Partial<Omit<SceneRow, 'id' | 'playId' | 'createdAt' | 'revision'>>) => Promise<void>;
  deleteScene: (sceneId: string) => Promise<void>;
  reorderScenes: (orderedIds: string[]) => Promise<void>;
  bumpProgress: (sceneId: string, delta: number) => Promise<void>;
  toggleSelectScene: (sceneId: string) => void;
  setSelectedSceneIds: (ids: string[]) => void;
  selectAllScenes: () => void;
  clearSelection: () => void;
  setOnlySelected: (value: boolean) => void;
  orderedScenes: () => SceneRow[];
  selectedScenes: () => SceneRow[];
  totalDurationMin: () => number;
  progressOf: (sceneId: string) => number;
}

export const useSceneStore = create<SceneStoreState>((set, get) => ({
  scenes: [],
  activePlayId: null,
  selectedSceneIds: [],
  onlySelected: readLocalFlag(STORAGE_KEYS.sceneOnlySelected, false),
  loading: false,
  error: '',

  async loadScenes(playId) {
    set({ loading: true, error: '' });
    try {
      const scenes = await listScenesByPlay(playId);
      const validIds = new Set(scenes.map((scene) => scene.id));
      set((state) => ({
        scenes,
        activePlayId: playId,
        loading: false,
        selectedSceneIds: state.activePlayId === playId ? state.selectedSceneIds.filter((id) => validIds.has(id)) : [],
      }));
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '场次读取失败' });
    }
  },

  clearScenes() {
    set({ scenes: [], activePlayId: null, selectedSceneIds: [] });
  },

  async createScene(playId, draft) {
    const current = get().scenes.filter((scene) => scene.playId === playId);
    const stamp = nowIso();
    const row: SceneRow = {
      id: uuid(),
      playId,
      seq: current.length + 1,
      title: draft.title.trim() || `第 ${current.length + 1} 场`,
      durationMin: Math.max(1, Math.round(draft.durationMin)),
      stageNote: draft.stageNote.trim(),
      needsShadowScreen: draft.needsShadowScreen,
      progress: clampProgress(draft.progress),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putScene(row);
    await get().loadScenes(playId);
    return row;
  },

  async createSceneFromPrevious(playId, previous) {
    const current = get().scenes.filter((scene) => scene.playId === playId);
    return get().createScene(playId, {
      title: `第 ${current.length + 1} 场`,
      durationMin: previous ? previous.durationMin : 12,
      stageNote: previous ? previous.stageNote : '',
      needsShadowScreen: previous ? previous.needsShadowScreen : 'standard',
      progress: 0,
    });
  },

  async updateScene(sceneId, patch) {
    const existing = get().scenes.find((scene) => scene.id === sceneId);
    if (!existing) return;
    const next: SceneRow = {
      ...existing,
      ...patch,
      progress: patch.progress === undefined ? existing.progress : clampProgress(patch.progress),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await putScene(next);
    await get().loadScenes(existing.playId);
  },

  async deleteScene(sceneId) {
    const existing = get().scenes.find((scene) => scene.id === sceneId);
    if (!existing) return;
    await removeScene(sceneId);
    const rest = get()
      .scenes.filter((scene) => scene.playId === existing.playId && scene.id !== sceneId)
      .sort((a, b) => a.seq - b.seq)
      .map((scene, index) => ({ ...scene, seq: index + 1, updatedAt: nowIso(), revision: ROW_REVISION }));
    if (rest.length > 0) await putScenes(rest);
    await get().loadScenes(existing.playId);
  },

  async reorderScenes(orderedIds) {
    const { scenes, activePlayId } = get();
    if (!activePlayId || orderedIds.length === 0) return;
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const reordered = [...scenes]
      .filter((scene) => scene.playId === activePlayId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((scene, index) => ({ ...scene, seq: index + 1, updatedAt: nowIso(), revision: ROW_REVISION }));
    await putScenes(reordered);
    await get().loadScenes(activePlayId);
  },

  async bumpProgress(sceneId, delta) {
    const existing = get().scenes.find((scene) => scene.id === sceneId);
    if (!existing) return;
    await get().updateScene(sceneId, { progress: clampProgress(existing.progress + delta) });
  },

  toggleSelectScene(sceneId) {
    const selected = get().selectedSceneIds;
    set({
      selectedSceneIds: selected.includes(sceneId)
        ? selected.filter((id) => id !== sceneId)
        : [...selected, sceneId],
    });
  },

  setSelectedSceneIds(ids) {
    set({ selectedSceneIds: [...ids] });
  },

  selectAllScenes() {
    set({ selectedSceneIds: get().scenes.map((scene) => scene.id) });
  },

  clearSelection() {
    set({ selectedSceneIds: [] });
  },

  setOnlySelected(value) {
    set({ onlySelected: value });
    writeLocalFlag(STORAGE_KEYS.sceneOnlySelected, value);
  },

  orderedScenes() {
    return [...get().scenes].sort((a, b) => a.seq - b.seq);
  },

  selectedScenes() {
    const selected = new Set(get().selectedSceneIds);
    return get()
      .orderedScenes()
      .filter((scene) => selected.has(scene.id));
  },

  totalDurationMin() {
    return get()
      .orderedScenes()
      .reduce((acc, scene) => acc + (Number.isFinite(scene.durationMin) ? scene.durationMin : 0), 0);
  },

  progressOf(sceneId) {
    return get().scenes.find((scene) => scene.id === sceneId)?.progress ?? 0;
  },
}));
