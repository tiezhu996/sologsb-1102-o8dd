/**
 * 排演包（RehearsalPackage）数据模型
 *
 * 分队离线排同一出戏：包里带「上次交接底稿 base」和「这次改动后的当前数据 current」，
 * 班社收包后以 base / 本机当前 / 包里 current 做三方合并。
 *
 * 包内一律只使用业务编号（playCode / sceneCode / roleCode / operatorCode / cueCode / slotCode）
 * 表达归属与指派，不带任何本机 uuid，因此「本机编号不同」也能正确认关系。
 */
import type { Play, PlayGenre, PlayStatus } from './play';
import type { Scene, ShadowScreenSpec } from './scene';
import type { ShadowRole, RoleType, PropPart } from './role';
import type { Operator, SkillTag, Weekday, BusySlot } from './operator';
import type { PercussionCue, BeatName, Instrument } from './cue';

/** 包格式标识 */
export const PACKAGE_KIND = 'gbshadowplay-rehearsal-package';
/** 排演包结构版本 */
export const PACKAGE_VERSION = 1;

/* --------------------------- 包内行（去本机化） --------------------------- */

export interface PackagePlay {
  playCode: string;
  title: Play['title'];
  genre: PlayGenre;
  scriptText: Play['scriptText'];
  totalScenes: number;
  premiereVenue: Play['premiereVenue'];
  status: PlayStatus;
}

export interface PackageScene {
  sceneCode: string;
  playCode: string;
  seq: Scene['seq'];
  title: Scene['title'];
  durationMin: Scene['durationMin'];
  stageNote: Scene['stageNote'];
  needsShadowScreen: ShadowScreenSpec;
  progress: Scene['progress'];
}

export interface PackageRole {
  roleCode: string;
  sceneCode: string;
  name: ShadowRole['name'];
  roleType: RoleType;
  propParts: PropPart[];
  entranceCue: ShadowRole['entranceCue'];
  lineNote: ShadowRole['lineNote'];
  /** 指派给操耍人的业务编号，未指派为 null */
  operatorCode: string | null;
}

export interface PackageCue {
  cueCode: string;
  sceneCode: string;
  beatName: BeatName;
  instrument: Instrument;
  atSecond: PercussionCue['atSecond'];
  /** 领奏操耍人业务编号，未指派为 null */
  leadOperatorCode: string | null;
  note: PercussionCue['note'];
}

export interface PackageSlot {
  slotCode: string;
  weekday: Weekday;
  startMinute: BusySlot['startMinute'];
  durationMinute: BusySlot['durationMinute'];
  label: BusySlot['label'];
}

export interface PackageOperator {
  operatorCode: string;
  name: Operator['name'];
  skillTags: SkillTag[];
  busySlots: PackageSlot[];
  rehearsalHours: Operator['rehearsalHours'];
}

/** 某一时刻的完整截面（底稿或本次改动后） */
export interface PackageSnapshot {
  play: PackagePlay;
  scenes: PackageScene[];
  roles: PackageRole[];
  cues: PackageCue[];
  /** 操耍人是班社级档案，整包全量带上；两边都改时按 operatorCode 三方合并 */
  operators: PackageOperator[];
}

/**
 * 分队交接排演包。
 * base：上次交接时的底稿（老工具导出的旧包可能没有，合并时按本机当前记录迁移补齐）。
 * current：该分队这次离线排演后的结果。
 */
export interface RehearsalPackage {
  kind: typeof PACKAGE_KIND;
  packageVersion: number;
  /** 包业务编号：同包内容导出多次保持不变，用于合并会话幂等去重 */
  packageCode: string;
  /** 打包分队名，仅展示用 */
  brigadeName: string;
  /** 打包说明（分队可写交接备注） */
  note: string;
  exportedAt: string;
  base: PackageSnapshot | null;
  current: PackageSnapshot;
}

/** 包内归属关系只认业务编号，任一行都不允许出现本机 uuid 外键 */
export interface PackageValidationIssue {
  level: 'error' | 'warning';
  message: string;
}
