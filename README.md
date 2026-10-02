# 皮影戏排演编排台（gbshadowplay）

面向皮影戏班社的排练统筹与舞台监督工具：把一出台戏拆成场次，为每个影人角色指定操耍人与锣鼓点，并跟踪各场次的排练成熟度。核心动作是「建剧目 → 拆场次 → 指派影人与操耍人 → 标注锣鼓点 → 推进排练进度」。两个分队离线排同一出戏时，各自导出**排演包**，回班社后在**合并台**按业务编号三方合并回剧目。

纯前端单页应用，**无后端 / 无数据库服务 / 无 API**，所有数据保存在访问者本机浏览器里（IndexedDB）。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先准备环境变量
cp .env.example .env

# 2. 一条命令构建并启动
docker compose up -d --build
```

启动后访问：**http://localhost:21802**

常用命令：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f frontend` |
| 停止服务 | `docker compose down` |
| 改名/改端口 | 编辑 `.env` 中的 `COMPOSE_PROJECT_NAME`、`FRONTEND_PORT` 后重新 `docker compose up -d --build` |
| 校验编排文件 | `docker compose config --quiet` |

> 顶层已写 `name: gbshadowplay` 兜底，即使本项目放在中文目录下，`docker compose config --quiet` 也不会因为项目名为空而报错。

---

## 二、项目简介

| 模块 | 说明 |
| --- | --- |
| 剧目库 | 新建剧目、按剧种（传统折子/新编）与状态（筹备中/排练中/可上演）筛选，环形指示展示平均排练成熟度 |
| 场次拆分 | 场序表拖拽调序（自动重排并落库）、按场次勾选「本次排练覆盖范围」、左右相邻场次合计时长参考 |
| 角色指派 | 登记全场影人角色（行当 / 需备影件 / 出场提示 / 唱白要点），为每个角色指派操耍人 |
| 锣鼓点时间轴 | 按秒点插入急急风/四击头/水底鱼，选主奏乐器与领奏操耍人，刻度尺可点击定位、可试排播放 |
| 操耍人档 | 维护技能标签（签子/连本/武打）与冲突时段，查看每人已派角色与累计排练时长，两两时段冲突对比 |

**冲突拦截**：指派操耍人时，会依据该人已排时段与同场其他影人操耍人的时段做重叠判定，冲突的候选人在下拉中直接禁用并给出拦截原因；操耍人自身时段互相重叠也会高亮预警。

---

## 分队离线排演与合并

两个分队各自带走同一出戏离线排，回班社后把排演包合并回剧目：

1. **导出排演包**：场次拆分页点「导出排演包」，填分队名导出 `.rpk.json`。包内含两份截面——`base`（上次交接底稿）与 `current`（分队这次改动后的全量）。同一交接周期重复导出，`packageCode` 保持不变。
2. **回班社接收**：合并台（`/merges`）接收排演包，自动生成合并方案与合并会话。
3. **冲突核对**：
   - 认关系**只看业务编号**（剧目 `JU-` / 场次 `CH-` / 影人角色 `YING-` / 操耍人 `CAO-` / 锣鼓点 `LUO-` / 档期 `SLOT-`），包内不带本机 uuid，**两台机器本机编号不同也绝不会硬套错关系**；
   - 同一字段两边都改过 → 两个版本**并列保留**，逐字段二选一，全部选定后才允许一起写入；
   - 一边撤了场次 / 操耍人、另一边还改过 → 去留二选一。
4. **级联处理干净**：撤场次时该场影人角色与锣鼓点随场清理；撤操耍人时所有剧目中相关角色指派、锣鼓点领奏全局解绑（待重派）。
5. **失败可重试、绝不重复追加**：合并会话（`mergeSessions` 表）原样保留整包与已核对进度（自动保存）。同一 `packageCode` 的包再次导入直接复用会话；已落盘的包重复接收只回显结果；落盘在单个事务内完成，失败不留半成品。
6. **旧数据迁移**：旧包缺少 `base` 底稿时，自动按本机当前记录迁移补齐再合并——本机改动不会被误判为冲突，且因无法证明分队撤掉了什么，只吸收包内新增与可确认的改动、不删除本机数据。旧库（v2）升级时按稳定顺序补发全部业务编号，并为现有剧目建立首次交接底稿。
7. 合并成功后，该剧目的交接底稿刷新为合并结果（下一轮交接的 `base`）；**剧目库与排练通告 CSV 展示的都是合并后的最终结果**。

---

## 三、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | 18.3 |
| 语言 | TypeScript（`strict`，无 `any`） | 5.6 |
| 构建 | Vite | 5.4 |
| UI 组件 | Ant Design（`@ant-design/icons`） | 5.22 |
| 状态管理 | Zustand | 4.5 |
| 路由 | React Router（`createBrowserRouter`） | 6.28 |
| 本地数据库 | Dexie（IndexedDB 封装，含结构版本号与升级迁移） | 4.0 |
| 容器 | 多阶段构建：`node:20-alpine` → `nginx:alpine` | — |

---

## 四、本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21802
npm run build    # tsc -b && vite build（类型检查 + 生产构建）
npm run preview  # 本地预览构建产物
npm test         # 合并引擎 + IndexedDB 端到端 + v2→v3 迁移 三组自测（fake-indexeddb，Node 直跑）
```

要求 Node.js 20 及以上（Docker 构建阶段固定使用 `node:20-alpine`）。

---

## 五、目录结构

```
sologsb-1102/
├── docker-compose.yml          # 顶层 name + 服务 frontend（不写 version 字段）
├── .env.example / .env         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── README.md
└── frontend/                   # 前端源码
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 + nginx:alpine 托管
    ├── nginx.conf              # SPA fallback（try_files）+ gzip
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    └── src/
        ├── types/              # play.ts scene.ts role.ts operator.ts cue.ts package.ts
        ├── stores/             # playStore.ts sceneStore.ts operatorStore.ts（Zustand）
        ├── components/common/  # SceneCard.tsx AssigneePicker.tsx ProgressRing.tsx EmptyState.tsx
        ├── hooks/              # useSceneOrder.ts useOperatorConflict.ts
        ├── pages/              # PlayList / SceneBoard / RoleAssign / CueTimeline / OperatorList
        │                         MergeCenter.tsx MergeReview.tsx（合并台 / 冲突核对）
        ├── router/             # index.tsx（路由表 + 懒加载分包）
        ├── utils/              # db / code / packageIO / mergeEngine / mergeService / export / timecode 等
        ├── scripts/            # testMerge / testIntegration / testMigration（npm test，Node 直跑）
        ├── styles/main.css     # 皮影暖纸底主题样式
        ├── App.tsx             # 布局与外层导航
        └── main.tsx            # 入口：ConfigProvider(zh_CN) + RouterProvider
```

### 路由表

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plays` | 剧目库 | Play |
| `/plays/:id/scenes` | 场次拆分与调序 | Scene、Play |
| `/scenes/:id/roles` | 角色与操耍人指派 | ShadowRole、Operator |
| `/scenes/:id/cues` | 锣鼓点时间轴 | PercussionCue、Scene |
| `/operators` | 操耍人档与时段冲突 | Operator |
| `/merges` | 合并台：接收排演包、会话列表 | MergeSession |
| `/merges/:id` | 冲突核对与落盘 | MergeSession、三方合并方案 |

### 数据模型

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| Play 剧目 | `src/types/play.ts` | id、**playCode**、title、genre、scriptText、totalScenes、premiereVenue、status |
| Scene 场次 | `src/types/scene.ts` | id、**sceneCode**、playId、seq、title、durationMin、stageNote、needsShadowScreen、progress |
| ShadowRole 影人角色 | `src/types/role.ts` | id、**roleCode**、sceneId、name、roleType、propParts、entranceCue、lineNote、operatorId |
| Operator 操耍人 | `src/types/operator.ts` | id、**operatorCode**、name、skillTags、busySlots（含 **slotCode**）、assignedRoleIds、rehearsalHours |
| PercussionCue 锣鼓点 | `src/types/cue.ts` | id、**cueCode**、sceneId、beatName、instrument、atSecond、leadOperator、note |

> `id` 是本机 uuid，仅用于本机外键；`*Code` 是跨机业务编号，分队合并只认它。包内（`src/types/package.ts`）只携带业务编号与截面数据，不含任何本机 id。

### 合并相关模块

| 文件 | 职责 |
| --- | --- |
| `src/utils/code.ts` | 业务编号前缀 / 发号 / 旧号解析 |
| `src/types/package.ts` | 排演包（`RehearsalPackage`：base + current）与包内行类型 |
| `src/utils/packageIO.ts` | 出包（剥本机 id、带上底稿、稳定 packageCode）与收包校验 |
| `src/utils/mergeEngine.ts` | 纯函数三方合并：字段并列冲突、去留冲突、级联、选定后构建最终数据集 |
| `src/utils/mergeService.ts` | 合并会话编排：建会话、存进度、事务落盘、业务编号↔uuid 映射、幂等 |

---

## 六、数据存储说明

- **IndexedDB（Dexie）**：`src/utils/db.ts` 封装全部读写，数据库名 `gbshadowplay`，当前结构版本 **3**。
  - v3 起所有实体带业务编号，新增三张表：`meta`（业务编号顺序计数器等）、`handoverBases`（每剧目上次交接底稿，主键 `playCode`）、`mergeSessions`（合并会话：整包、核对进度、落盘汇报、失败原因）；`cues` 补 `leadOperator` 索引。
  - `version(3).upgrade()` 中：按「剧目建档时间 / 场次场序 / 角色建档时间 / 操耍人姓名 / 鼓点秒点」的稳定顺序补发业务编号（同源数据两台机器发号一致），补齐 `slotCode`、计数器、首次交接底稿，行 `revision` 升到 3。
  - 新建 / 合并写入的行若缺业务编号，由 db 层统一发号；计数器持久化在 `meta` 表，绝不重号。
- **localStorage**：`src/utils/localStore.ts` 统一封装界面偏好（最近打开的剧目、场次页「只看本次勾选」开关等）。
- **首次打开**：数据库为空时自动灌入示例班社数据（3 出剧目 / 6 个场次 / 12 个影人角色 / 4 位操耍人 / 10 处锣鼓点），保证界面开箱即有内容可点。
- **导入导出**：剧目库支持导出整库 JSON 存档、导入存档覆盖、以及重置为示例数据；操耍人档支持导出 CSV；场次拆分页可导出单剧目**排练通告 CSV**（最终合并结果）与分队**排演包 `.rpk.json`**。
- **容器无状态**：数据只存在访问者的浏览器里，不使用数据库服务、不挂载命名卷；清除站点数据即等于恢复出厂状态。

---

## 七、容器化要点

- `frontend/Dockerfile`：多阶段构建，`node:20-alpine` 执行 `npm ci` 与 `npm run build`（`tsc -b` 类型检查通过），产物交给 `nginx:alpine` 托管。
- `frontend/nginx.conf`：`try_files $uri $uri/ /index.html;` 支持前端路由直接刷新，开启 gzip（含 JS/CSS/JSON/SVG/字体等类型），静态指纹资源长缓存、入口 HTML 不缓存。
- `docker-compose.yml`：不写 `version:` 字段；顶层 `name: gbshadowplay`；服务 `frontend` 使用 `container_name: ${COMPOSE_PROJECT_NAME:-gbshadowplay}-frontend`；端口映射 `"${FRONTEND_PORT:-21802}:80"`。
- 端口：宿主 `21802` → 容器 `80`。
