/**
 * 端到端集成自测（fake-indexeddb，不入前端构建）
 * 运行：npx esbuild scripts/testIntegration.ts --bundle --platform=node --format=esm | node
 */
import 'fake-indexeddb/auto';
import {
  db,
  DB_SCHEMA_VERSION,
  initDatabase,
  listAllRoles,
  listScenesByPlay,
  getPlayByCode,
  getMergeSessionByPackage,
  getHandoverBase,
  nextCode,
  ROW_REVISION,
} from '../src/utils/db';
import {
  buildRehearsalPackage,
  parseRehearsalPackage,
} from '../src/utils/packageIO';
import {
  applyMerge,
  openSessionForPackage,
  recomputePlan,
  saveResolutions,
} from '../src/utils/mergeService';
import { nowIso } from '../src/utils/uuid';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}
async function section(title: string): Promise<void> {
  console.log(`\n== ${title}`);
}

await section('1. 建库 + seed：业务编号与首次底稿');
await initDatabase();
assert(DB_SCHEMA_VERSION === 3, '结构版本 v3');
const plays = await db.plays.toArray();
const scenesAll = await db.scenes.toArray();
const rolesAll = await db.roles.toArray();
const cuesAll = await db.cues.toArray();
const operatorsAll = await db.operators.toArray();
assert(plays.length === 3, `示例 3 剧目（实际 ${plays.length}）`);
assert(plays.every((p) => /^JU-\d{4,}$/.test(p.playCode)), '剧目均有 playCode');
assert(scenesAll.every((s) => /^CH-\d{4,}$/.test(s.sceneCode)), '场次均有 sceneCode');
assert(rolesAll.every((r) => /^YING-\d{4,}$/.test(r.roleCode)), '角色均有 roleCode');
assert(cuesAll.every((c) => /^LUO-\d{4,}$/.test(c.cueCode)), '锣鼓点均有 cueCode');
assert(operatorsAll.every((o) => /^CAO-\d{4,}$/.test(o.operatorCode)), '操耍人均有 operatorCode');
assert(
  operatorsAll.every((o) => o.busySlots.every((s) => /^SLOT-\d{4,}$/.test(s.slotCode ?? ''))),
  '档期均有 slotCode',
);
const firstPlay = plays[0];
const baseRow = await getHandoverBase(firstPlay.playCode);
assert(Boolean(baseRow), '每个剧目建立了首次交接底稿');
assert(baseRow?.snapshot.roles.length !== undefined && baseRow.snapshot.roles.length > 0, '底稿含角色');
// 编号计数器
const playCounter = await db.meta.get('counter:play');
assert(typeof playCounter?.value === 'number' && (playCounter.value as number) >= 3, '计数器已播种');

await section('2. 分队离线改 + 班社同改 → 出包、合并、冲突并列');
// 取该剧目第一场与一个角色
const playScenes0 = await listScenesByPlay(firstPlay.id);
const scene0 = playScenes0[0];
const sceneRoles0 = await db.roles.where('sceneId').equals(scene0.id).toArray();
const role0 = sceneRoles0[0];

// 先导出分队包（此时 base=current=seed）
const brigadePkg = await buildRehearsalPackage({
  playId: firstPlay.id,
  brigadeName: '东路一组',
  note: '离线排第一场',
});
assert(brigadePkg.base !== null, '包里带了上次交接底稿');
const parsed = parseRehearsalPackage(JSON.stringify(brigadePkg));
assert(parsed.issues.filter((i) => i.level === 'error').length === 0, '包校验通过');

// 模拟分队在“另一台机”上的改动：直接改这台库（改场次进度 + 角色唱白），然后重新出包
await db.scenes.put({ ...scene0, progress: 88, updatedAt: nowIso(), revision: ROW_REVISION });
await db.roles.put({
  ...role0,
  lineNote: '分队改的唱白：拖腔走满八拍',
  updatedAt: nowIso(),
  revision: ROW_REVISION,
});
const brigadePkg2 = await buildRehearsalPackage({
  playId: firstPlay.id,
  brigadeName: '东路一组',
});
assert(brigadePkg2.packageCode === brigadePkg.packageCode, '同交接周期重复导出 packageCode 稳定');
assert(brigadePkg2.current.scenes.find((s) => s.sceneCode === scene0.sceneCode)?.progress === 88, '包 current 带分队进度');
assert(brigadePkg2.base?.scenes.find((s) => s.sceneCode === scene0.sceneCode)?.progress === scene0.progress, '包 base 仍是旧底稿');

// 回到班社：把数据改回“班社自己的改动”（同字段两边都改）
await db.scenes.put({ ...scene0, progress: 66, updatedAt: nowIso(), revision: ROW_REVISION });
await db.roles.put({
  ...role0,
  lineNote: '班社改的唱白：收在板上',
  updatedAt: nowIso(),
  revision: ROW_REVISION,
});

const { session, reused } = await openSessionForPackage(brigadePkg2);
assert(!reused, '首次接收建立新会话');
const { plan } = await recomputePlan(session);
const progressConflict = plan.conflicts.find((c) => c.entity === 'scene' && c.field === 'progress');
const lineConflict = plan.conflicts.find((c) => c.entity === 'role' && c.field === 'lineNote');
assert(Boolean(progressConflict), '场次进度同字段两边改 → 并列冲突');
assert(Boolean(lineConflict), '角色唱白同字段两边改 → 并列冲突');

// 未选定直接落盘应被拦截
let blocked = false;
try {
  await applyMerge(session.id, {});
} catch {
  blocked = true;
}
assert(blocked, '冲突未选定不能写入');

// 选定：进度采纳分队 88，唱白采纳班社
const resolutions: Record<string, 'local' | 'remote'> = {};
if (progressConflict) resolutions[progressConflict.id] = 'remote';
if (lineConflict) resolutions[lineConflict.id] = 'local';
await saveResolutions(session.id, resolutions);
const { report } = await applyMerge(session.id, resolutions);
const afterPlay = await getPlayByCode(firstPlay.playCode);
const afterScenes = await listScenesByPlay(afterPlay!.id);
const afterRole = await db.roles.get(role0.id);
assert(afterScenes.find((s) => s.sceneCode === scene0.sceneCode)?.progress === 88, '选定后进度=分队 88');
assert(afterRole?.lineNote === '班社改的唱白：收在板上', '选定后唱白=班社版');
assert(report.fieldConflicts >= 2, '汇报记录字段冲突数');

await section('3. 幂等：同包再接收/再应用不重复追加');
const again = await openSessionForPackage(brigadePkg2);
assert(again.reused && again.session.status === 'applied', '同包复用已完成会话');
const roleCountBefore = await db.roles.count();
const sceneCountBefore = await db.scenes.count();
const second = await applyMerge(session.id, resolutions);
assert(second.report.appliedAt === report.appliedAt, '重复应用返回同一份落盘汇报');
assert((await db.roles.count()) === roleCountBefore, '角色未重复追加');
assert((await db.scenes.count()) === sceneCountBefore, '场次未重复追加');
const sessionByCode = await getMergeSessionByPackage(brigadePkg2.packageCode);
assert(semverOneSession(sessionByCode?.packageCode, brigadePkg2.packageCode), '同 packageCode 只有一个会话');
function semverOneSession(a?: string, b?: string): boolean {
  return a === b;
}
// 合并后底稿已刷新为合并结果
const refreshedBase = await getHandoverBase(firstPlay.playCode);
assert(refreshedBase?.snapshot.scenes.find((s) => s.sceneCode === scene0.sceneCode)?.progress === 88, '交接底稿刷新为最终结果');

await section('4. 撤场级联落盘 + 撤操耍人解绑落盘');
// 取第二出戏（影话·迁徙）做撤场；其场次有角色/鼓点
const play2 = (await db.plays.toArray()).find((p) => p.title.includes('迁徙'))!;
const scenes2 = await listScenesByPlay(play2.id);
const targetScene = scenes2[0];
const childRoles = await db.roles.where('sceneId').equals(targetScene.id).toArray();
const childCues = await db.cues.where('sceneId').equals(targetScene.id).toArray();
const pkgDel = await buildRehearsalPackage({ playId: play2.id, brigadeName: '西路组' });
// 分队撤场（连同角色/鼓点从 current 移除）
pkgDel.current.scenes = pkgDel.current.scenes.filter((s) => s.sceneCode !== targetScene.sceneCode);
pkgDel.current.roles = pkgDel.current.roles.filter((r) => r.sceneCode !== targetScene.sceneCode);
pkgDel.current.cues = pkgDel.current.cues.filter((c) => c.sceneCode !== targetScene.sceneCode);
const sessDel = await openSessionForPackageSafe(pkgDel);
const planDel = (await recomputePlan(sessDel)).plan;
assert(
  planDel.changes.scenes.some((c) => c.code === targetScene.sceneCode && c.action === 'delete'),
  '方案中该场为撤掉',
);
await applyMerge(sessDel.id, {});
assert((await db.scenes.get(targetScene.id)) === undefined, '本机场次已删');
assert((await db.roles.where('sceneId').equals(targetScene.id).count()) === 0, '该场角色清干净');
assert((await db.cues.where('sceneId').equals(targetScene.id).count()) === 0, '该场锣鼓点清干净');
assert(childRoles.length > 0 && childCues.length > 0, '前置：该场原本确有角色和鼓点');

// 撤操耍人：第三出戏
const play3 = (await db.plays.toArray()).find((p) => p.title.includes('大闹天宫'))!;
const pkgOp = await buildRehearsalPackage({ playId: play3.id, brigadeName: '南路组' });
const removedOpCode = pkgOp.current.roles.find((r) => r.operatorCode !== null)?.operatorCode ?? null;
assert(removedOpCode !== null, '找到被指派的操耍人编号');
pkgOp.current.operators = pkgOp.current.operators.filter((o) => o.operatorCode !== removedOpCode);
pkgOp.current.roles = pkgOp.current.roles.map((r) =>
  r.operatorCode === removedOpCode ? { ...r, operatorCode: null } : r,
);
pkgOp.current.cues = pkgOp.current.cues.map((c) =>
  c.leadOperatorCode === removedOpCode ? { ...c, leadOperatorCode: null } : c,
);
const sessOp = await openSessionForPackageSafe(pkgOp);
await applyMerge(sessOp.id, {});
const operatorIds = new Set((await db.operators.toArray()).map((o) => o.id));
const operatorCodesNow = new Set((await db.operators.toArray()).map((o) => o.operatorCode));
assert(!operatorCodesNow.has(removedOpCode as string), '被撤操耍人已从班社档删除');
const allRoles = await listAllRoles();
const danglingRoles = allRoles.filter((r) => r.operatorId !== null && !operatorIds.has(r.operatorId));
assert(danglingRoles.length === 0, '没有指向已撤操耍人的悬空角色指派');
const leadDangling = (await db.cues.toArray()).filter(
  (c) => c.leadOperator !== null && !operatorIds.has(c.leadOperator as string),
);
assert(leadDangling.length === 0, '没有指向已撤操耍人的悬空领奏');

// 造一个「本机后续新加、包里完全没覆盖」的操耍人，合并后必须原样保留
const outsiderOpId = 'op-outsider-uuid';
const outsiderOpCode = 'CAO-9001';
await db.operators.put({
  id: outsiderOpId,
  operatorCode: outsiderOpCode,
  name: '后来新收的师傅',
  skillTags: ['wuda'],
  busySlots: [],
  assignedRoleIds: [],
  rehearsalHours: 0,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  revision: ROW_REVISION,
});
const pkgOpAgain = await buildRehearsalPackage({ playId: play3.id, brigadeName: '南路组二包' });
// 模拟旧分队机器：它的快照里完全没有这个后来新加的操耍人（base/current 都剔除）
pkgOpAgain.current.operators = pkgOpAgain.current.operators.filter((o) => o.operatorCode !== outsiderOpCode);
if (pkgOpAgain.base) {
  pkgOpAgain.base.operators = pkgOpAgain.base.operators.filter((o) => o.operatorCode !== outsiderOpCode);
}
const sessOp2 = await openSessionForPackageSafe(pkgOpAgain);
await applyMerge(sessOp2.id, {});
const outsider = await db.operators.where('operatorCode').equals(outsiderOpCode).first();
assert(Boolean(outsider), '包没覆盖到的本机操耍人不被误删');

// 合入一个带很大编号的异机新增角色后，本机后续发号必须顶到它之后，不撞号
const highCode = 'YING-9999';
const pkgHigh = await buildRehearsalPackage({ playId: play3.id, brigadeName: '高号分队' });
pkgHigh.current.roles.push({
  roleCode: highCode,
  sceneCode: pkgHigh.current.scenes[0].sceneCode,
  name: '异机高号角色',
  roleType: 'shenguai',
  propParts: [],
  entranceCue: '',
  lineNote: '',
  operatorCode: null,
});
const sessHigh = await openSessionForPackageSafe(pkgHigh);
await applyMerge(sessHigh.id, {});
const highRow = await db.roles.where('roleCode').equals(highCode).first();
assert(Boolean(highRow), '异机高号角色已合入');
const nextRoleCode = await nextCode('role');
assert(Number(nextRoleCode.split('-')[1]) > 9999, '本机下一个 roleCode 顶到高号之后，不撞号');

await section('5. 缺底稿旧包：迁移补齐后只吸收不删除');
// 手工构造一个无 base 的包（伪旧工具导出）
const playForLegacy = (await db.plays.toArray()).find((p) => p.title.includes('白蛇传'))!;
const pkgLegacy = await buildRehearsalPackage({ playId: playForLegacy.id, brigadeName: '老分队' });
(pkgLegacy as { base: null }).base = null;
const legacyScenes = pkgLegacy.current.scenes;
// 分队改第一场进度，并且不带第二场（旧工具漏带）
pkgLegacy.current.scenes = legacyScenes.slice(0, 1).map((s) =>
  s.seq === 1 ? { ...s, progress: 77 } : s,
);
const sessLegacy = await openSessionForPackageSafe(pkgLegacy);
const planLegacy = (await recomputePlan(sessLegacy)).plan;
assert(planLegacy.baselineMigrated, '识别为缺底稿并迁移补齐');
assert(planLegacy.changes.scenes.every((c) => c.action !== 'delete'), '迁移基线不产生删除');
await applyMerge(sessLegacy.id, {});
const legacyScenesAfter = await listScenesByPlay(playForLegacy.id);
assert(legacyScenesAfter.length === legacyScenes.length, '本机场次一个不少');
assert(legacyScenesAfter.find((s) => s.seq === 1)?.progress === 77, '分队的进度改动被吸收');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);

async function openSessionForPackageSafe(pkg: unknown) {
  const { session } = await openSessionForPackage(pkg as Parameters<typeof openSessionForPackage>[0]);
  return session;
}
