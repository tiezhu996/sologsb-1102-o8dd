/**
 * 首次打开应用时灌入的示例班社数据
 * 只在 plays 表为空时执行，保证界面第一次进入就有可点通的内容。
 */
import { db, ROW_REVISION, type CueRow, type OperatorRow, type PlayRow, type RoleRow, type SceneRow } from './db';
import { uuid, nowIso } from './uuid';

interface SeedSceneSpec {
  title: string;
  durationMin: number;
  stageNote: string;
  needsShadowScreen: SceneRow['needsShadowScreen'];
  progress: number;
  roles: Array<{
    name: string;
    roleType: RoleRow['roleType'];
    propParts: RoleRow['propParts'];
    entranceCue: string;
    lineNote: string;
    operatorIndex: number | null;
  }>;
  cues: Array<{
    beatName: CueRow['beatName'];
    instrument: CueRow['instrument'];
    atSecond: number;
    note: string;
    leadOperatorIndex: number | null;
  }>;
}

interface SeedPlaySpec {
  title: string;
  genre: PlayRow['genre'];
  scriptText: string;
  premiereVenue: string;
  status: PlayRow['status'];
  scenes: SeedSceneSpec[];
}

const OPERATORS: Array<Pick<OperatorRow, 'name' | 'skillTags' | 'busySlots' | 'rehearsalHours'>> = [
  {
    name: '霍连生',
    skillTags: ['qianzi', 'lianben'],
    rehearsalHours: 42,
    busySlots: [
      { id: 'slot-hls-1', weekday: 1, startMinute: 0, durationMinute: 180, label: '周一上午·连排《借伞》' },
      { id: 'slot-hls-2', weekday: 4, startMinute: 120, durationMinute: 150, label: '周四午后·合乐' },
    ],
  },
  {
    name: '苗凤仪',
    skillTags: ['qianzi', 'wuda'],
    rehearsalHours: 36,
    busySlots: [
      { id: 'slot-mfy-1', weekday: 1, startMinute: 60, durationMinute: 120, label: '周一上午·武场对打' },
      { id: 'slot-mfy-2', weekday: 5, startMinute: 0, durationMinute: 200, label: '周五整日·走台' },
    ],
  },
  {
    name: '裴三保',
    skillTags: ['lianben', 'wuda'],
    rehearsalHours: 28,
    busySlots: [{ id: 'slot-psb-1', weekday: 2, startMinute: 240, durationMinute: 120, label: '周二下午·神怪场' }],
  },
  {
    name: '闻小楼',
    skillTags: ['qianzi'],
    rehearsalHours: 19,
    busySlots: [{ id: 'slot-wxl-1', weekday: 3, startMinute: 0, durationMinute: 150, label: '周三上午·新编场' }],
  },
];

const PLAYS: SeedPlaySpec[] = [
  {
    title: '白蛇传·借伞',
    genre: 'traditional',
    scriptText:
      '西湖断桥，许仙与白娘子因借伞结缘。全剧以水袖与影窗烟雨见长，末场水漫金山需大锣急急风催台，神怪影件需换用双联影窗。',
    premiereVenue: '滦州影戏馆 · 正台',
    status: 'rehearsing',
    scenes: [
      {
        title: '第一场·游湖',
        durationMin: 14,
        stageNote: '烟雨影窗拉满，四把青伞自左下入场，水袖走圆场两周。',
        needsShadowScreen: 'standard',
        progress: 100,
        roles: [
          {
            name: '白娘子',
            roleType: 'dan',
            propParts: ['toucha', 'shenduan'],
            entranceCue: '四击头落定后自影窗右侧起伞',
            lineNote: '「十年修得同船渡」一句拖腔走满八拍',
            operatorIndex: 0,
          },
          {
            name: '许仙',
            roleType: 'sheng',
            propParts: ['toucha', 'shenduan'],
            entranceCue: '小锣三击后自左侧上场',
            lineNote: '念白需压住锣鼓点，末字落在板上',
            operatorIndex: 3,
          },
        ],
        cues: [
          { beatName: 'sijitou', instrument: 'bangu', atSecond: 8, note: '开场亮相四击头', leadOperatorIndex: 0 },
          { beatName: 'shuidiyu', instrument: 'xiaoluo', atSecond: 96, note: '撑伞走圆场', leadOperatorIndex: 3 },
        ],
      },
      {
        title: '第二场·结亲',
        durationMin: 18,
        stageNote: '影窗收至半幅，喜堂红影件更换约 40 秒，间以板鼓独奏垫场。',
        needsShadowScreen: 'large',
        progress: 72,
        roles: [
          {
            name: '白娘子',
            roleType: 'dan',
            propParts: ['toucha', 'shenduan'],
            entranceCue: '喜乐起后自中门上场',
            lineNote: '唱段第二句转慢板，注意换气',
            operatorIndex: 0,
          },
          {
            name: '小青',
            roleType: 'dan',
            propParts: ['toucha', 'shenduan', 'bingqi'],
            entranceCue: '大锣一击亮剑花',
            lineNote: '剑花与铙钹同起同落',
            operatorIndex: 1,
          },
          {
            name: '法海',
            roleType: 'jing',
            propParts: ['toucha', 'shenduan'],
            entranceCue: '闷帘念白后上场',
            lineNote: '念白多用丹田音，压过小锣',
            operatorIndex: 2,
          },
        ],
        cues: [
          { beatName: 'jijifeng', instrument: 'daluo', atSecond: 42, note: '法海逼近，急急风催台', leadOperatorIndex: 2 },
          { beatName: 'sijitou', instrument: 'naobo', atSecond: 260, note: '亮剑四击头', leadOperatorIndex: 1 },
        ],
      },
      {
        title: '第三场·水漫',
        durationMin: 22,
        stageNote: '双联影窗换水族影件，锣鼓全堂入，末段灯暗留白三秒。',
        needsShadowScreen: 'twin',
        progress: 35,
        roles: [
          {
            name: '白娘子',
            roleType: 'dan',
            propParts: ['toucha', 'shenduan', 'bingqi'],
            entranceCue: '水声起后踏浪上场',
            lineNote: '高腔需与铙钹对咬，不可拖',
            operatorIndex: 1,
          },
          {
            name: '水族头目',
            roleType: 'shenguai',
            propParts: ['toucha', 'shenduan'],
            entranceCue: '急急风起连绵入场',
            lineNote: '群场走位对齐鼓点，不开口',
            operatorIndex: 2,
          },
          {
            name: '许仙',
            roleType: 'sheng',
            propParts: ['toucha', 'shenduan'],
            entranceCue: '小锣一击后跌步上场',
            lineNote: '跌步含三次呼吸，落在板上',
            operatorIndex: 3,
          },
        ],
        cues: [
          { beatName: 'jijifeng', instrument: 'daluo', atSecond: 15, note: '水漫起势', leadOperatorIndex: 2 },
          { beatName: 'jijifeng', instrument: 'naobo', atSecond: 90, note: '浪头叠起第二层', leadOperatorIndex: 1 },
          { beatName: 'sijitou', instrument: 'bangu', atSecond: 480, note: '终场收煞', leadOperatorIndex: 0 },
        ],
      },
    ],
  },
  {
    title: '影话·迁徙',
    genre: 'newly',
    scriptText:
      '新编现代影戏，以候鸟迁徙对应三代皮影艺人的走班往事。影窗以长条横幕替代传统方窗，锣鼓点与电子声场混编。',
    premiereVenue: '滨河小剧场 · 实验台',
    status: 'preparing',
    scenes: [
      {
        title: '第一场·开箱',
        durationMin: 16,
        stageNote: '老箱开启，影件依次投影于横幕，需人工换件配合板鼓。',
        needsShadowScreen: 'standard',
        progress: 15,
        roles: [
          {
            name: '老班主',
            roleType: 'chou',
            propParts: ['toucha', 'shenduan'],
            entranceCue: '板鼓独奏中自影窗左侧入',
            lineNote: '念白带乡音，尾音落小锣',
            operatorIndex: 3,
          },
        ],
        cues: [{ beatName: 'shuidiyu', instrument: 'bangu', atSecond: 20, note: '开箱水底鱼垫场', leadOperatorIndex: 3 }],
      },
      {
        title: '第二场·走班',
        durationMin: 20,
        stageNote: '横幕滑动表现赶路，影件抄件需提前备两套。',
        needsShadowScreen: 'twin',
        progress: 0,
        roles: [
          {
            name: '少年班主',
            roleType: 'sheng',
            propParts: ['toucha', 'shenduan', 'bingqi'],
            entranceCue: '急急风起，快步上场',
            lineNote: '唱段节奏偏快，需咬清字头',
            operatorIndex: null,
          },
        ],
        cues: [],
      },
    ],
  },
  {
    title: '大闹天宫·借扇',
    genre: 'traditional',
    scriptText: '孙悟空三借芭蕉扇，武场密集，影人拆件更换频繁，适合作为班社巡演保留剧目。',
    premiereVenue: '唐山影戏园 · 二台',
    status: 'ready',
    scenes: [
      {
        title: '第一场·借扇',
        durationMin: 19,
        stageNote: '武打走位需与锣鼓点逐拍对齐，兵器影件备双份。',
        needsShadowScreen: 'large',
        progress: 100,
        roles: [
          {
            name: '孙悟空',
            roleType: 'chou',
            propParts: ['toucha', 'shenduan', 'bingqi'],
            entranceCue: '四击头后翻身上场',
            lineNote: '念白快而脆，末字落在板上',
            operatorIndex: 1,
          },
          {
            name: '铁扇公主',
            roleType: 'dan',
            propParts: ['toucha', 'shenduan', 'bingqi'],
            entranceCue: '大锣一击亮扇',
            lineNote: '与悟空对咬鼓点，不可抢板',
            operatorIndex: 2,
          },
        ],
        cues: [
          { beatName: 'sijitou', instrument: 'bangu', atSecond: 30, note: '借扇亮相', leadOperatorIndex: 1 },
          { beatName: 'jijifeng', instrument: 'daluo', atSecond: 210, note: '开打急急风', leadOperatorIndex: 2 },
        ],
      },
    ],
  },
];

/** 灌入示例数据 */
export async function seedDatabase(): Promise<void> {
  const stamp = nowIso();
  const operatorRows: OperatorRow[] = OPERATORS.map((item) => ({
    ...item,
    id: uuid(),
    assignedRoleIds: [],
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }));

  const playRows: PlayRow[] = [];
  const sceneRows: SceneRow[] = [];
  const roleRows: RoleRow[] = [];
  const cueRows: CueRow[] = [];

  PLAYS.forEach((playSpec) => {
    const playId = uuid();
    playRows.push({
      id: playId,
      title: playSpec.title,
      genre: playSpec.genre,
      scriptText: playSpec.scriptText,
      totalScenes: playSpec.scenes.length,
      premiereVenue: playSpec.premiereVenue,
      status: playSpec.status,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });

    playSpec.scenes.forEach((sceneSpec, sceneIndex) => {
      const sceneId = uuid();
      sceneRows.push({
        id: sceneId,
        playId,
        seq: sceneIndex + 1,
        title: sceneSpec.title,
        durationMin: sceneSpec.durationMin,
        stageNote: sceneSpec.stageNote,
        needsShadowScreen: sceneSpec.needsShadowScreen,
        progress: sceneSpec.progress,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      });

      sceneSpec.roles.forEach((roleSpec) => {
        const operator = roleSpec.operatorIndex === null ? null : operatorRows[roleSpec.operatorIndex];
        const roleId = uuid();
        roleRows.push({
          id: roleId,
          sceneId,
          name: roleSpec.name,
          roleType: roleSpec.roleType,
          propParts: [...roleSpec.propParts],
          entranceCue: roleSpec.entranceCue,
          lineNote: roleSpec.lineNote,
          operatorId: operator ? operator.id : null,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
        if (operator) operator.assignedRoleIds.push(roleId);
      });

      sceneSpec.cues.forEach((cueSpec) => {
        const lead = cueSpec.leadOperatorIndex === null ? null : operatorRows[cueSpec.leadOperatorIndex];
        cueRows.push({
          id: uuid(),
          sceneId,
          beatName: cueSpec.beatName,
          instrument: cueSpec.instrument,
          atSecond: cueSpec.atSecond,
          leadOperator: lead ? lead.id : null,
          note: cueSpec.note,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
      });
    });
  });

  await db.transaction('rw', db.plays, db.scenes, db.roles, db.operators, db.cues, async () => {
    await db.operators.bulkPut(operatorRows);
    await db.plays.bulkPut(playRows);
    await db.scenes.bulkPut(sceneRows);
    await db.roles.bulkPut(roleRows);
    await db.cues.bulkPut(cueRows);
  });
}
