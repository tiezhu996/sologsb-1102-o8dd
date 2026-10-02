/**
 * 合并引擎逻辑自测（不入构建，仅 node 运行）
 * 运行：npx esbuild scripts/testMerge.ts --bundle --platform=node --format=esm | node
 */
import {
  buildMergedDataset,
  createMergePlan,
  datasetFromSnapshot,
  isPlanResolved,
  type MergeDataset,
} from '../src/utils/mergeEngine';
import type {
  PackageCue,
  PackageOperator,
  PackagePlay,
  PackageRole,
  PackageScene,
  PackageSnapshot,
} from '../src/types/package';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

const play = (over: Partial<PackagePlay> = {}): PackagePlay => ({
  playCode: 'JU-0001',
  title: '借伞',
  genre: 'traditional',
  scriptText: '',
  totalScenes: 1,
  premiereVenue: '滦州',
  status: 'rehearsing',
  ...over,
});
const scene = (over: Partial<PackageScene> = {}): PackageScene => ({
  sceneCode: 'CH-0001',
  playCode: 'JU-0001',
  seq: 1,
  title: '第一场·游湖',
  durationMin: 14,
  stageNote: '',
  needsShadowScreen: 'standard',
  progress: 10,
  ...over,
});
const role = (over: Partial<PackageRole> = {}): PackageRole => ({
  roleCode: 'YING-0001',
  sceneCode: 'CH-0001',
  name: '白娘子',
  roleType: 'dan',
  propParts: ['toucha'],
  entranceCue: '',
  lineNote: '',
  operatorCode: 'CAO-0001',
  ...over,
});
const cue = (over: Partial<PackageCue> = {}): PackageCue => ({
  cueCode: 'LUO-0001',
  sceneCode: 'CH-0001',
  beatName: 'sijitou',
  instrument: 'bangu',
  atSecond: 8,
  leadOperatorCode: 'CAO-0001',
  note: '',
  ...over,
});
const operator = (over: Partial<PackageOperator> = {}): PackageOperator => ({
  operatorCode: 'CAO-0001',
  name: '霍连生',
  skillTags: ['qianzi'],
  busySlots: [
    { slotCode: 'SLOT-0001', weekday: 1, startMinute: 0, durationMinute: 60, label: '周一早课' },
  ],
  rehearsalHours: 10,
  ...over,
});
function snap(over: Partial<PackageSnapshot> = {}): PackageSnapshot {
  return {
    play: play(),
    scenes: [scene()],
    roles: [role()],
    cues: [cue()],
    operators: [operator()],
    ...over,
  };
}
const meta = { packageCode: 'BAO-1', packageLabel: '借伞', brigadeName: '东路组', exportedAt: '2026-10-02', playCode: 'JU-0001' };

function planOf(local: PackageSnapshot, base: PackageSnapshot, remote: PackageSnapshot, migrated = false) {
  return createMergePlan(datasetFromSnapshot(local), datasetFromSnapshot(base), datasetFromSnapshot(remote), meta, {
    baselineMigrated: migrated,
  });
}

/* ---- 1. 字段两边各改不同字段：无冲突，自动合并 ---- */
section('1. 各改一边 → 自动合并无冲突');
{
  const base = snap();
  const local = snap({ play: play({ title: '借伞（班社改）' }) });
  const remote = snap({ play: play({ premiereVenue: '唐山小剧场' }) });
  const plan = planOf(local, base, remote);
  assert(plan.conflicts.length === 0, '无字段冲突');
  assert(isPlanResolved(plan, {}), '无需选定');
  const merged = buildMergedDataset(plan, {});
  assert(merged.play?.title === '借伞（班社改）', '本机改的标题保留');
  assert(merged.play?.premiereVenue === '唐山小剧场', '分队改的戏台吸收');
}

/* ---- 2. 同字段两边都改：并列冲突，选定后写入 ---- */
section('2. 同字段两边都改 → 并列保留，待选定');
{
  const base = snap();
  const local = snap({ scenes: [scene({ progress: 80 })] });
  const remote = snap({ scenes: [scene({ progress: 40 })] });
  const plan = planOf(local, base, remote);
  assert(plan.conflicts.length === 1 && plan.conflicts[0].field === 'progress', 'progress 冲突 1 处');
  assert(!isPlanResolved(plan, {}), '未选定时不可落盘');
  const id = plan.conflicts[0].id;
  const mergedRemote = buildMergedDataset(plan, { [id]: 'remote' });
  assert(mergedRemote.scenes.get('CH-0001')?.progress === 40, '选分队 → 40');
  const mergedLocal = buildMergedDataset(plan, { [id]: 'local' });
  assert(mergedLocal.scenes.get('CH-0001')?.progress === 80, '选本机 → 80');
}

/* ---- 3. 业务编号相同、本机 uuid 无关：包改角色名，正确认到同角色 ---- */
section('3. 按业务编号认关系（不看本机编号）');
{
  const base = snap();
  const local = snap();
  const remote = snap({ roles: [role({ name: '白素贞' })] });
  const plan = planOf(local, base, remote);
  assert(plan.conflicts.length === 0, '单改名字不冲突');
  const merged = buildMergedDataset(plan, {});
  const rows = [...merged.roles.values()];
  assert(rows.length === 1 && rows[0].name === '白素贞', '同 roleCode 行被更新而非追加');
}

/* ---- 4. 分队撤场（本机未改）：场次 + 角色 + 锣鼓点清理干净 ---- */
section('4. 分队撤场 → 级联清理');
{
  const base = snap();
  const local = snap();
  const remote = snap({ scenes: [], roles: [], cues: [] });
  const plan = planOf(local, base, remote);
  assert(plan.changes.scenes[0].action === 'delete', '场次动作为 delete');
  assert(plan.warnings.some((w) => w.message.includes('白娘子')), '有角色级联提示');
  assert(plan.warnings.some((w) => w.message.includes('锣鼓点')), '有锣鼓点级联提示');
  const merged = buildMergedDataset(plan, {});
  assert(merged.scenes.size === 0, '场次已无');
  assert(merged.roles.size === 0, '角色已清');
  assert(merged.cues.size === 0, '锣鼓点已清');
  // 操耍人是班社档，不随戏删除
  assert(merged.operators.size === 1, '操耍人档保留');
}

/* ---- 5. 分队撤场但本机改过：去留冲突，选保留 → 全保留 ---- */
section('5. 一边撤场一边改 → 去留冲突');
{
  const base = snap();
  const local = snap({ scenes: [scene({ progress: 55 })] });
  const remote = snap({ scenes: [], roles: [], cues: [] });
  const plan = planOf(local, base, remote);
  assert(plan.entityConflicts.length === 1 && plan.entityConflicts[0].entity === 'scene', '产生场次去留冲突');
  const id = plan.entityConflicts[0].id;
  assert(!isPlanResolved(plan, {}), '未选定不可落盘');
  const kept = buildMergedDataset(plan, { [id]: 'keep' });
  assert(kept.scenes.size === 1 && kept.roles.size === 1 && kept.cues.size === 1, '选保留 → 场/角色/鼓点都在');
  const deleted = buildMergedDataset(plan, { [id]: 'delete' });
  assert(deleted.scenes.size === 0 && deleted.roles.size === 0 && deleted.cues.size === 0, '选撤掉 → 级联清干净');
}

/* ---- 6. 分队撤操耍人（本机未改）：人删，角色指派/领奏解绑 ---- */
section('6. 撤操耍人 → 指派解绑');
{
  const base = snap();
  const local = snap();
  const remote = snap({ operators: [] });
  const plan = planOf(local, base, remote);
  assert(plan.changes.operators[0].action === 'delete', '操耍人动作 delete');
  assert(plan.warnings.some((w) => w.message.includes('指派已解绑')), '角色解绑提示');
  assert(plan.warnings.some((w) => w.message.includes('领奏已解绑')), '领奏解绑提示');
  const merged = buildMergedDataset(plan, {});
  assert(merged.operators.size === 0, '操耍人删除');
  assert(merged.roles.get('YING-0001')?.operatorCode === null, '角色指派清空');
  assert(merged.cues.get('LUO-0001')?.leadOperatorCode === null, '鼓点领奏清空');
}

/* ---- 7. 本机撤操耍人，分队改了他：去留冲突 ---- */
section('7. 本机撤人 / 分队改人');
{
  const base = snap();
  const local = snap({ operators: [] });
  const remote = snap({ operators: [operator({ rehearsalHours: 20 })] });
  const plan = planOf(local, base, remote);
  assert(plan.entityConflicts.some((c) => c.entity === 'operator'), '操耍人去留冲突');
}

/* ---- 8. 缺底稿迁移补齐：不产生删除，本机未碰改动不误判 ---- */
section('8. 旧包缺底稿迁移 → 不删除本机行');
{
  // base 按本机当前补齐：本机有 2 场，包里只带 1 场（分队没碰第二场）
  const s2 = scene({ sceneCode: 'CH-0002', seq: 2, title: '第二场·结亲' });
  const local = snap({ scenes: [scene(), s2] });
  const base = local; // 迁移：底稿=本机当前
  const remote = snap({ scenes: [scene({ progress: 90 })] });
  const plan = planOf(local, base, remote, true);
  assert(plan.baselineMigrated, '标记为迁移基线');
  assert(plan.changes.scenes.every((c) => c.action !== 'delete'), '无删除动作');
  assert(plan.warnings.filter((w) => w.level === 'warning').length === 0, '无级联清理警告');
  const merged = buildMergedDataset(plan, {});
  assert(merged.scenes.size === 2, '本机第二场保留（不被误删）');
  assert(merged.scenes.get('CH-0001')?.progress === 90, '分队改动吸收');
}

/* ---- 9. 档期时段：分队撤一个、加一个 ---- */
section('9. 档期时段三方');
{
  const newSlot = { slotCode: 'SLOT-0002', weekday: 2, startMinute: 0, durationMinute: 90, label: '周二加排' };
  const base = snap();
  const local = snap();
  const remote = snap({ operators: [operator({ busySlots: [newSlot] })] });
  const plan = planOf(local, base, remote);
  const slotChanges = plan.changes.slots;
  assert(slotChanges.find((s) => s.slotCode === 'SLOT-0001')?.action === 'delete', '旧时段撤掉');
  assert(slotChanges.find((s) => s.slotCode === 'SLOT-0002')?.action === 'add', '新时段加入');
  const merged = buildMergedDataset(plan, {});
  const slots = merged.operators.get('CAO-0001')?.busySlots.map((s) => s.slotCode) ?? [];
  assert(!slots.includes('SLOT-0001') && slots.includes('SLOT-0002'), '最终档期正确');
}

/* ---- 10. 分队新增行 → add；本机自有行（不在包/底稿）保留 ---- */
section('10. 新增 + 本机自有保留');
{
  const base = snap();
  const localRow = scene({ sceneCode: 'CH-0099', seq: 9, title: '本机自建场' });
  const local = snap({ scenes: [scene(), localRow] });
  const remoteAdded = scene({ sceneCode: 'CH-0002', seq: 2, title: '分队加场' });
  const remote = snap({ scenes: [scene(), remoteAdded] });
  const plan = planOf(local, base, remote);
  const merged = buildMergedDataset(plan, {});
  assert(merged.scenes.has('CH-0099'), '本机自建场保留');
  assert(merged.scenes.has('CH-0002'), '分队加场吸收');
  assert(merged.scenes.size === 3, '共 3 场（原 + 本机 + 分队）');
}

/* ---- 11. 两边都改同字段成相同值 → 不是冲突 ---- */
section('11. 两边改成一致 → 无冲突');
{
  const base = snap();
  const local = snap({ scenes: [scene({ title: '第一场·雨游' })] });
  const remote = snap({ scenes: [scene({ title: '第一场·雨游' })] });
  const plan = planOf(local, base, remote);
  assert(plan.conflicts.length === 0, '收敛一致无冲突');
  const merged = buildMergedDataset(plan, {});
  assert(merged.scenes.get('CH-0001')?.title === '第一场·雨游', '标题为新值');
}

/* ---- 12. 指派改人（operatorCode 字段三方） ---- */
section('12. 角色改派操耍人');
{
  const op2 = operator({ operatorCode: 'CAO-0002', name: '苗凤仪' });
  const base = snap();
  const local = snap();
  const remote = snap({ roles: [role({ operatorCode: 'CAO-0002' })], operators: [operator(), op2] });
  const plan = planOf(local, base, remote);
  const merged = buildMergedDataset(plan, {});
  assert(merged.roles.get('YING-0001')?.operatorCode === 'CAO-0002', '指派改到苗凤仪');
  assert(merged.operators.has('CAO-0002'), '新操耍人入档');
}

/* ---- 13. 冲突选择只存 id，重试用同一 plan 结果一致（幂等的数据基础） ---- */
section('13. 多冲突批量选择');
{
  const base = snap({ scenes: [scene()], roles: [role()], cues: [cue()] });
  const local = snap({
    scenes: [scene({ title: '本机场', progress: 70 })],
    roles: [role({ lineNote: '本机要点' })],
    cues: [cue({ note: '本机鼓注' })],
  });
  const remote = snap({
    scenes: [scene({ title: '分队场', progress: 20 })],
    roles: [role({ lineNote: '分队要点' })],
    cues: [cue({ note: '分队鼓注' })],
  });
  const plan = planOf(local, base, remote);
  assert(plan.conflicts.length >= 4, '多字段冲突');
  const res: Record<string, 'local' | 'remote'> = {};
  plan.conflicts.forEach((c) => {
    res[c.id] = 'remote';
  });
  assert(isPlanResolved(plan, res), '全部可选定');
  const merged1 = buildMergedDataset(plan, res);
  const merged2 = buildMergedDataset(plan, res);
  assert(JSON.stringify(merged1) === JSON.stringify(merged2), '同选择两次构建结果完全一致（重试幂等基础）');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
