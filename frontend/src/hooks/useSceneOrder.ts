/**
 * useSceneOrder(playId)
 * 场次排序、重排落库与相邻场次合计时长；被场次页与锣鼓点页消费。
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useSceneStore } from '../stores/sceneStore';
import { secondsToTimecode, accumulateStartSeconds, minutesToReadable } from '../utils/timecode';
import type { SceneRow } from '../utils/db';

export interface SceneOrderItem {
  scene: SceneRow;
  /** 该场开场秒点（相对整剧开场） */
  startSecond: number;
  /** 该场结束秒点 */
  endSecond: number;
  /** 该场时长（秒） */
  durationSecond: number;
  /** 展示用时间码 mm:ss */
  startTimecode: string;
  endTimecode: string;
  /** 全场累计到场末的分钟数 */
  accumulatedMinute: number;
}

export interface UseSceneOrderResult {
  scenes: SceneRow[];
  items: SceneOrderItem[];
  /** 本次勾选的场次 */
  selectedSceneIds: string[];
  selectedItems: SceneOrderItem[];
  /** 整剧合计时长（分钟 / 秒 / 可读文案） */
  totalMinute: number;
  totalSecond: number;
  totalReadable: string;
  selectedMinute: number;
  loading: boolean;
  error: string;
  /** 拖拽调序：传入新的场次 id 顺序 */
  reorder: (orderedIds: string[]) => Promise<void>;
  /** 相邻两场合计时长（分钟） */
  adjacentMinute: (index: number) => number;
  toggleSelected: (sceneId: string) => void;
  selectAll: () => void;
  clearSelected: () => void;
  refresh: () => Promise<void>;
}

export function useSceneOrder(playId: string | null | undefined): UseSceneOrderResult {
  const scenes = useSceneStore((state) => state.scenes);
  const selectedSceneIds = useSceneStore((state) => state.selectedSceneIds);
  const loading = useSceneStore((state) => state.loading);
  const error = useSceneStore((state) => state.error);
  const loadScenes = useSceneStore((state) => state.loadScenes);
  const reorderScenes = useSceneStore((state) => state.reorderScenes);
  const toggleSelectScene = useSceneStore((state) => state.toggleSelectScene);
  const selectAllScenes = useSceneStore((state) => state.selectAllScenes);
  const clearSelection = useSceneStore((state) => state.clearSelection);

  const refresh = useCallback(async () => {
    if (!playId) return;
    await loadScenes(playId);
  }, [loadScenes, playId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const orderedScenes = useMemo(() => [...scenes].sort((a, b) => a.seq - b.seq), [scenes]);

  const items = useMemo<SceneOrderItem[]>(() => {
    const startMap = accumulateStartSeconds(orderedScenes);
    let accumulated = 0;
    return orderedScenes.map((scene) => {
      const durationSecond = Math.max(0, scene.durationMin) * 60;
      const startSecond = startMap[scene.id] ?? 0;
      const endSecond = startSecond + durationSecond;
      accumulated += Math.max(0, scene.durationMin);
      return {
        scene,
        startSecond,
        endSecond,
        durationSecond,
        startTimecode: secondsToTimecode(startSecond),
        endTimecode: secondsToTimecode(endSecond),
        accumulatedMinute: accumulated,
      };
    });
  }, [orderedScenes]);

  const selectedSet = useMemo(() => new Set(selectedSceneIds), [selectedSceneIds]);
  const selectedItems = useMemo(() => items.filter((item) => selectedSet.has(item.scene.id)), [items, selectedSet]);

  const totalMinute = useMemo(
    () => orderedScenes.reduce((acc, scene) => acc + (Number.isFinite(scene.durationMin) ? scene.durationMin : 0), 0),
    [orderedScenes],
  );
  const selectedMinute = useMemo(
    () => selectedItems.reduce((acc, item) => acc + (Number.isFinite(item.scene.durationMin) ? item.scene.durationMin : 0), 0),
    [selectedItems],
  );

  const adjacentMinute = useCallback(
    (index: number): number => {
      const left = items[index];
      const right = items[index + 1];
      if (!left || !right) return left ? left.scene.durationMin : 0;
      return left.scene.durationMin + right.scene.durationMin;
    },
    [items],
  );

  return {
    scenes: orderedScenes,
    items,
    selectedSceneIds,
    selectedItems,
    totalMinute,
    totalSecond: totalMinute * 60,
    totalReadable: minutesToReadable(totalMinute),
    selectedMinute,
    loading,
    error,
    reorder: reorderScenes,
    adjacentMinute,
    toggleSelected: toggleSelectScene,
    selectAll: selectAllScenes,
    clearSelected: clearSelection,
    refresh,
  };
}
