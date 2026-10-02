/**
 * /merge 排演包合并中心
 * 打包（分队离线前）+ 回班社合并（开包 → 核对冲突 → 一起写入）。
 * 合并失败后重试同一包：按 packageId 找回会话，已核对进度与整包都保留，不重复追加。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileZipOutlined,
  HistoryOutlined,
  InboxOutlined,
  MergeCellsOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import { usePlayStore } from '../stores/playStore';
import { useOperatorStore } from '../stores/operatorStore';
import { formatStamp } from '../utils/uuid';
import {
  FIELD_META,
  conflictKey,
  isSceneDeleted,
  type EntityPlan,
  type MergePlan,
} from './mergeEngine';
import {
  abandonMerge,
  createRehearsalPackage,
  deleteMergeSession,
  downloadPackage,
  fetchMergeSessions,
  openRehearsalPackage,
  reopenSession,
  saveResolution,
  submitMerge,
} from './mergeService';
import type { RehearsalPackageView } from './packageIO';
import type { LocalScope } from './commitMerge';
import type {
  ArrayPolicy,
  DeletePolicy,
  FieldSide,
  MergeEntityKind,
  MergeSessionRecord,
} from '../types/rehearsalPackage';
import { ArrayConflictEditor, DeleteModifyEditor, FieldConflictEditor } from './ConflictEditors';

const KIND_LABEL: Record<MergeEntityKind, string> = {
  play: '剧目',
  scene: '场次',
  role: '影人角色',
  cue: '锣鼓点',
  operator: '操耍人',
};

const STATUS_META: Record<EntityPlan['status'], { label: string; color: string }> = {
  unchanged: { label: '无变化', color: 'default' },
  localOnly: { label: '仅本机', color: 'blue' },
  remoteOnly: { label: '分队新增', color: 'green' },
  modified: { label: '有改动', color: 'gold' },
  deleted: { label: '撤掉', color: 'red' },
  conflict: { label: '待核对', color: 'volcano' },
};

interface ActiveMerge {
  pkg: RehearsalPackageView;
  session: MergeSessionRecord;
  plan: MergePlan;
  scope: LocalScope;
}

export default function MergeCenter() {
  const { message, modal } = App.useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const packForm = Form.useForm<{ playId: string; detachmentName: string }>()[0];
  const [packOpen, setPackOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<MergeSessionRecord[]>([]);
  const [active, setActive] = useState<ActiveMerge | null>(null);

  const plays = usePlayStore((state) => state.plays);
  const loadPlays = usePlayStore((state) => state.loadPlays);
  const operators = useOperatorStore((state) => state.operators);
  const loadOperators = useOperatorStore((state) => state.loadOperators);

  useEffect(() => {
    void Promise.all([loadPlays(), loadOperators()]).then(() => undefined);
  }, [loadPlays, loadOperators]);

  const refreshSessions = useCallback(async () => {
    setSessions(await fetchMergeSessions());
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  /** 操耍人业务编号 → 姓名（冲突展示用） */
  const operatorNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    operators.forEach((operator) => map.set(operator.bizCode, operator.name));
    active?.pkg &&
      [active.pkg.current.operators, active.pkg.baseline?.operators ?? []].forEach((rows) => {
        rows.forEach((operator) => {
          if (!map.has(operator.bizCode)) map.set(operator.bizCode, operator.name);
        });
      });
    return map;
  }, [operators, active]);

  const unresolvedCount = active ? active.plan.entries.reduce(
    (acc, entry) => acc + entry.conflicts.filter((conflict) => conflict.resolution === null).length,
    0,
  ) : 0;

  const openPackModal = () => {
    packForm.setFieldsValue({
      playId: plays[0]?.id ?? '',
      detachmentName: '',
    });
    setPackOpen(true);
  };

  const handlePack = async () => {
    const values = await packForm.validateFields();
    setBusy(true);
    try {
      const built = await createRehearsalPackage(values.playId, values.detachmentName.trim());
      const filename = downloadPackage(built.payload);
      message.success(`排演包已生成：${filename}（含上次交接底稿与本次改动）`);
      setPackOpen(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '打包失败');
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      const opened = await openRehearsalPackage(text);
      setActive(opened);
      if (opened.session.status === 'committed') {
        message.info('这是已合并过的同一包：结果幂等，不会重复追加');
      } else if (opened.reopened) {
        message.success('找到上次未完成的核对进度，已恢复');
      } else {
        message.success('排演包已打开，请核对差异与冲突');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '排演包打开失败');
    } finally {
      setBusy(false);
    }
  };

  const handleResolution = async (entry: EntityPlan, conflictIndex: number, value: FieldSide | ArrayPolicy | DeletePolicy) => {
    if (!active) return;
    const conflict = entry.conflicts[conflictIndex];
    conflict.resolution = value as never;
    // 随选随存：刷新计划派生状态 + 落库进度
    setActive({ ...active, plan: { ...active.plan, entries: [...active.plan.entries] } });
    await saveResolution({
      sessionId: active.session.id,
      key: conflictKey(entry, conflictIndex),
      value,
    });
    if (conflict.resolution !== null) {
      message.success(`「${entry.label}」的核对已保存`);
    }
  };

  const handleSubmit = () => {
    if (!active) return;
    if (unresolvedCount > 0) {
      message.warning(`还有 ${unresolvedCount} 处冲突未核对`);
      return;
    }
    const deletedScenes = active.plan.entries.filter(
      (entry) => entry.kind === 'scene' && isSceneDeleted(entry),
    ).length;
    modal.confirm({
      title: '确认把核对结果一起写入剧目库？',
      content:
        deletedScenes > 0
          ? `将按核对结果合并；${deletedScenes} 个场次会撤掉，其下角色指派与锣鼓点一并清理。`
          : '同一包重复提交不会重复追加；提交后剧目库与排练通告即显示最终结果。',
      okText: '一起写入',
      cancelText: '再核对',
      onOk: async () => {
        if (!active) return;
        setBusy(true);
        try {
          const outcome = await submitMerge(active.session, active.plan, active.pkg, active.scope);
          message.success(
            `合并完成：新增场次 ${outcome.scenesAdded}、角色 ${outcome.rolesAdded}、锣鼓点 ${outcome.cuesAdded}、操耍人 ${outcome.operatorsAdded}；` +
              `撤掉场次 ${outcome.scenesDeleted}，级联清角色 ${outcome.cascadedRoles} / 锣鼓点 ${outcome.cascadedCues}。`,
          );
          await Promise.all([loadPlays(), loadOperators(), refreshSessions()]);
          setActive(null);
        } catch (error) {
          // 合并失败：整包与已核对进度都保留，可直接重试
          message.error(`合并未写入（进度已保留，可重试同一包）：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const handleReopen = async (session: MergeSessionRecord) => {
    setBusy(true);
    try {
      const opened = await reopenSession(session.id);
      setActive(opened);
      if (session.status === 'committed') message.info('该包已合并，可查看最终结果或重新核对后再提交（幂等）');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '打开失败');
    } finally {
      setBusy(false);
    }
  };

  const handleAbandon = (session: MergeSessionRecord) => {
    modal.confirm({
      title: '放弃这次合并？',
      content: '整包会保留为「已放弃」备查，不再出现在待合并列表；之后可手动删除记录。',
      okText: '放弃',
      cancelText: '取消',
      onOk: async () => {
        await abandonMerge(session.id);
        await refreshSessions();
        if (active?.session.id === session.id) setActive(null);
        message.success('已放弃，整包记录仍保留');
      },
    });
  };

  const formatConflictValue = useCallback(
    (entry: EntityPlan, field: string, value: unknown): string => {
      if (
        (entry.kind === 'role' && field === 'operatorId') ||
        (entry.kind === 'cue' && field === 'leadOperator')
      ) {
        if (value === null || value === undefined || value === '') return '待指派';
        const code = String(value);
        return operatorNameByCode.get(code) ? `${operatorNameByCode.get(code)}（${code}）` : `编号 ${code}（操耍人档中不存在）`;
      }
      const meta = FIELD_META[entry.kind].find((item) => item.field === field);
      return meta ? meta.format(value) : String(value ?? '');
    },
    [operatorNameByCode],
  );

  const sessionColumns: ColumnsType<MergeSessionRecord> = [
    {
      title: '分队',
      dataIndex: 'detachmentName',
      width: 120,
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
    },
    {
      title: '剧目编号',
      dataIndex: 'playBizCode',
      width: 110,
      className: 'gb-mono',
    },
    {
      title: '打包时间',
      dataIndex: 'pkg',
      width: 150,
      render: (pkg: MergeSessionRecord['pkg']) => formatStamp(pkg.createdAt),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: MergeSessionRecord['status']) => {
        const map = {
          pending: { color: 'processing', label: '待合并' },
          committed: { color: 'success', label: '已合并' },
          abandoned: { color: 'default', label: '已放弃' },
        } as const;
        const meta = map[status];
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<RollbackOutlined />} onClick={() => void handleReopen(record)}>
            {record.status === 'pending' ? '继续核对' : '重新打开'}
          </Button>
          {record.status === 'pending' ? (
            <Button size="small" type="link" onClick={() => void handleAbandon(record)}>
              放弃
            </Button>
          ) : null}
          <Tooltip title="删除整包记录（不影响已写入的剧目数据）">
            <Button
              size="small"
              type="link"
              danger
              icon={<DeleteOutlined />}
              onClick={() => {
                modal.confirm({
                  title: '删除该排演包记录？',
                  content: '仅删除本机保存的整包与核对进度，已合并写入的数据不受影响。',
                  okText: '删除',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: async () => {
                    await deleteMergeSession(record.id);
                    await refreshSessions();
                    if (active?.session.id === record.id) setActive(null);
                  },
                });
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const conflictEntries = active ? active.plan.entries.filter((entry) => entry.conflicts.length > 0) : [];
  const changedEntries = active
    ? active.plan.entries.filter((entry) =>
        ['modified', 'remoteOnly', 'localOnly', 'deleted', 'conflict'].includes(entry.status),
      )
    : [];
  const hasErrors = active ? active.plan.warnings.some((warning) => warning.level === 'error') : false;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              <MergeCellsOutlined /> 离线排演包
            </Typography.Title>
            <Typography.Text type="secondary">
              分队离线排同一出戏：打包带走「上次交接底稿 + 本次改动」；回班社按剧目、场次、影人角色与操耍人业务编号认关系合并
            </Typography.Text>
          </div>
          <Space wrap>
            <Button type="primary" icon={<DownloadOutlined />} onClick={openPackModal}>
              给分队打包
            </Button>
            <Button icon={<CloudUploadOutlined />} onClick={() => fileInputRef.current?.click()} loading={busy}>
              回班社合并
            </Button>
            <Button icon={<HistoryOutlined />} onClick={() => void refreshSessions()}>
              刷新记录
            </Button>
          </Space>
        </div>
        <Space size={24} wrap>
          <Statistic title="本机剧目" value={plays.length} />
          <Statistic title="操耍人档" value={operators.length} />
          <Statistic title="待合并整包" value={sessions.filter((item) => item.status === 'pending').length} />
          <Statistic title="已合并整包" value={sessions.filter((item) => item.status === 'committed').length} />
        </Space>
      </div>

      {active ? (
        <MergeWorkbench
          active={active}
          busy={busy}
          unresolvedCount={unresolvedCount}
          hasErrors={hasErrors}
          conflictEntries={conflictEntries}
          changedEntries={changedEntries}
          onClose={() => setActive(null)}
          onResolution={handleResolution}
          onSubmit={handleSubmit}
          onFormatValue={formatConflictValue}
          remoteLabel={`${active.pkg.detachmentName}（分队）`}
        />
      ) : (
        <div className="gb-panel">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={2}>
                <Typography.Text strong>还没有打开排演包</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  点「回班社合并」选择分队带回的 JSON 排演包；同一包可反复打开，核对进度自动保留
                </Typography.Text>
              </Space>
            }
          >
            <Button type="primary" icon={<InboxOutlined />} onClick={() => fileInputRef.current?.click()}>
              选择排演包
            </Button>
          </Empty>
        </div>
      )}

      <div className="gb-panel">
        <div className="gb-panel-title">
          <Typography.Text strong>
            <FileZipOutlined /> 排演包记录（整包与核对进度，失败重试不丢）
          </Typography.Text>
          <Tag>{sessions.length} 个</Tag>
        </div>
        <Table<MergeSessionRecord>
          rowKey="id"
          size="small"
          className="gb-table-compact"
          columns={sessionColumns}
          dataSource={sessions}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无排演包记录" /> }}
        />
      </div>

      <Modal
        open={packOpen}
        title="给分队打排演包"
        okText="生成并下载"
        cancelText="取消"
        onCancel={() => setPackOpen(false)}
        onOk={() => void handlePack()}
        confirmLoading={busy}
      >
        <Form form={packForm} layout="vertical">
          <Form.Item name="playId" label="剧目" rules={[{ required: true, message: '请选择剧目' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={plays.map((play) => ({
                value: play.id,
                label: `${play.title}（${play.bizCode}）`,
              }))}
              placeholder="选择要离线排的戏"
            />
          </Form.Item>
          <Form.Item
            name="detachmentName"
            label="分队名"
            rules={[{ required: true, message: '请填写分队名' }, { max: 20, message: '不超过 20 字' }]}
          >
            <Input placeholder="如：东路队 / 西路队" maxLength={20} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            排演包内含该戏全部场次、影人角色、锣鼓点与全档操耍人；首次打包以当前记录作为「上次交接底稿」。
          </Typography.Text>
        </Form>
      </Modal>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handleFile(file);
        }}
      />
    </Space>
  );
}

/* ------------------------------- 合并工作台 ------------------------------- */

interface WorkbenchProps {
  active: ActiveMerge;
  busy: boolean;
  unresolvedCount: number;
  hasErrors: boolean;
  conflictEntries: EntityPlan[];
  changedEntries: EntityPlan[];
  remoteLabel: string;
  onClose: () => void;
  onResolution: (entry: EntityPlan, conflictIndex: number, value: FieldSide | ArrayPolicy | DeletePolicy) => void;
  onSubmit: () => void;
  onFormatValue: (entry: EntityPlan, field: string, value: unknown) => string;
}

function MergeWorkbench(props: WorkbenchProps) {
  const { active, busy, unresolvedCount, hasErrors, conflictEntries, changedEntries, remoteLabel } = props;
  const { pkg, plan, session } = active;
  const playTitle = pkg.current.play.title;

  const summary: Array<{ key: EntityPlan['status']; label: string }> = [
    { key: 'remoteOnly', label: '分队新增' },
    { key: 'modified', label: '有改动' },
    { key: 'conflict', label: '待核对冲突' },
    { key: 'deleted', label: '撤掉' },
    { key: 'localOnly', label: '仅本机保留' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              核对合并 · {playTitle}
            </Typography.Title>
            <Tag color="gold" className="gb-mono">{pkg.playBizCode}</Tag>
            <Tag>{pkg.detachmentName}</Tag>
            {session.status === 'committed' ? <Tag color="success">该包已合并（幂等）</Tag> : null}
          </Space>
          <Space>
            <Button onClick={props.onClose}>收起</Button>
            <Button
              type="primary"
              icon={<MergeCellsOutlined />}
              disabled={hasErrors || unresolvedCount > 0}
              loading={busy}
              onClick={props.onSubmit}
            >
              {unresolvedCount > 0 ? `还有 ${unresolvedCount} 处待核对` : '核对完成，一起写入'}
            </Button>
          </Space>
        </div>

        <Descriptions size="small" column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label="打包时间">{formatStamp(pkg.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="包号">
            <span className="gb-mono">{pkg.packageId.slice(0, 13)}…</span>
          </Descriptions.Item>
          <Descriptions.Item label="底稿">
            {pkg.baseline ? `有（${formatStamp(pkg.baseline.play.updatedAt)} 交接）` : '缺失，已按当前记录迁移补齐'}
          </Descriptions.Item>
        </Descriptions>

        <Divider style={{ margin: '10px 0' }} />
        <Space size={20} wrap>
          {summary.map((item) => {
            const count = plan.entries.filter((entry) => entry.status === item.key).length;
            return <Tag key={item.key} color={STATUS_META[item.key].color}>{item.label} {count}</Tag>;
          })}
        </Space>

        {plan.warnings.map((warning, index) => (
          <Alert
            key={index}
            style={{ marginTop: 10 }}
            type={warning.level === 'error' ? 'error' : 'warning'}
            showIcon
            message={warning.message}
          />
        ))}
      </div>

      <div className="gb-panel">
        <div className="gb-panel-title">
          <Typography.Text strong>
            冲突核对（同字段两边都改：并列保留，选定后再一起写入）
          </Typography.Text>
          <Tag color={unresolvedCount > 0 ? 'volcano' : 'success'}>
            {unresolvedCount > 0 ? `待核对 ${unresolvedCount} 处` : '全部核对完成'}
          </Tag>
        </div>
        {conflictEntries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有字段冲突，可直接一起写入" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {conflictEntries.map((entry) => (
              <Card
                key={`${entry.kind}:${entry.bizCode}`}
                size="small"
                type="inner"
                title={
                  <Space size={6} wrap>
                    <Tag>{KIND_LABEL[entry.kind]}</Tag>
                    <Typography.Text strong>{entry.label}</Typography.Text>
                    <Typography.Text type="secondary" className="gb-mono" style={{ fontSize: 12 }}>
                      {entry.bizCode}
                    </Typography.Text>
                  </Space>
                }
              >
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  {entry.conflicts.map((conflict, conflictIndex) => {
                    if (conflict.conflictKind === 'field') {
                      const meta = FIELD_META[entry.kind].find((item) => item.field === conflict.field);
                      return (
                        <FieldConflictEditor
                          key={conflict.field}
                          conflict={conflict}
                          format={(value) =>
                            meta
                              ? props.onFormatValue(entry, conflict.field, value)
                              : String(value ?? '')
                          }
                          sideLabel={{ local: '班社本机', remote: remoteLabel }}
                          onChange={(value) => props.onResolution(entry, conflictIndex, value)}
                        />
                      );
                    }
                    if (conflict.conflictKind === 'array') {
                      return (
                        <ArrayConflictEditor
                          key={conflict.field}
                          conflict={conflict}
                          onChange={(value) => props.onResolution(entry, conflictIndex, value)}
                        />
                      );
                    }
                    return (
                      <DeleteModifyEditor
                        key="delete-modify"
                        conflict={conflict}
                        entityLabel={`${KIND_LABEL[entry.kind]}·${entry.label}`}
                        onChange={(value) => props.onResolution(entry, conflictIndex, value)}
                      />
                    );
                  })}
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </div>

      <div className="gb-panel">
        <div className="gb-panel-title">
          <Typography.Text strong>差异明细（最终结果预览）</Typography.Text>
          <Tag>{changedEntries.length} 项有变化</Tag>
        </div>
        <Table<EntityPlan>
          rowKey={(record) => `${record.kind}:${record.bizCode}`}
          size="small"
          className="gb-table-compact"
          columns={[
            {
              title: '类型',
              dataIndex: 'kind',
              width: 90,
              render: (kind: MergeEntityKind) => <Tag>{KIND_LABEL[kind]}</Tag>,
            },
            { title: '名称', dataIndex: 'label', width: 180, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
            { title: '编号', dataIndex: 'bizCode', width: 170, className: 'gb-mono', render: (value: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value}</Typography.Text> },
            {
              title: '结论',
              dataIndex: 'status',
              width: 100,
              render: (status: EntityPlan['status']) => <Tag color={STATUS_META[status].color}>{STATUS_META[status].label}</Tag>,
            },
            {
              title: '差异 / 级联处理',
              dataIndex: 'diffs',
              render: (_value, record) => (
                <Space direction="vertical" size={2}>
                  {record.diffs.map((diff, index) => (
                    <Typography.Text key={index} style={{ fontSize: 12 }} type={record.status === 'deleted' ? 'danger' : undefined}>
                      {diff}
                    </Typography.Text>
                  ))}
                  {record.kind === 'scene' && isSceneDeleted(record) ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      该场次下角色指派与锣鼓点会一并处理干净
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
          ]}
          dataSource={changedEntries}
          pagination={false}
          scroll={{ x: 760 }}
          expandable={{
            expandedRowRender: (record) =>
              record.conflicts.length > 0 ? (
                <Timeline
                  items={record.conflicts.map((conflict) => ({
                    color: conflict.resolution === null ? 'red' : 'green',
                    children: (
                      <Typography.Text type={conflict.resolution === null ? 'danger' : undefined} style={{ fontSize: 12 }}>
                        {conflict.conflictKind === 'deleteModify'
                          ? '删除/修改冲突待选'
                          : conflict.conflictKind === 'array'
                            ? `${conflict.fieldLabel}：${conflict.resolution === 'union' ? '并列保留' : conflict.resolution === 'local' ? '用本机' : conflict.resolution === 'remote' ? '用分队' : '待选'}`
                            : `${conflict.fieldLabel} 取「${
                                conflict.resolution === 'local' ? '班社本机' : conflict.resolution === 'remote' ? remoteLabel : '待选'
                              }」`}
                      </Typography.Text>
                    ),
                  }))}
                />
              ) : null,
          }}
        />
      </div>
    </Space>
  );
}
