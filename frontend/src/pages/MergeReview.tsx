/**
 * /merges/:id 冲突核对与落盘
 * - 字段两边都改：左右并列（本机 / 分队），逐字段二选一；选择自动保存进会话；
 * - 一边撤场 / 撤人、另一边改过：去留二选一；
 * - 选定齐全后一次性写入；失败保留整包与进度，可直接重试；
 * - 已落盘会话以只读结果展示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Radio,
  Result,
  Row,
  Space,
  Statistic,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  RetweetOutlined,
  SaveOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { getMergeSession, type MergeSessionRow } from '../utils/db';
import {
  applyMerge,
  recomputePlan,
  saveResolutions,
  UnresolvedConflictsError,
} from '../utils/mergeService';
import type { FieldConflict, EntityConflict, MergePlan, ResolutionMap } from '../utils/mergeEngine';
import { isPlanResolved, planStats } from '../utils/mergeEngine';
import { usePlayStore } from '../stores/playStore';
import { useOperatorStore } from '../stores/operatorStore';
import { ROUTES } from '../router';
import { formatStamp } from '../utils/uuid';
import {
  BEAT_NAME_LABEL,
  INSTRUMENT_LABEL,
} from '../types/cue';
import { PLAY_GENRE_LABEL, PLAY_STATUS_LABEL } from '../types/play';
import { ROLE_TYPE_LABEL, PROP_PART_LABEL } from '../types/role';
import { SHADOW_SCREEN_LABEL } from '../types/scene';
import { SKILL_TAG_LABEL, WEEKDAY_LABEL, minuteToClock } from '../types/operator';
import { secondsToTimecode } from '../utils/timecode';
import type { PackageOperator } from '../types/package';

type Choice = 'local' | 'remote' | 'keep' | 'delete' | undefined;

/** 把包内业务值翻译成人话（枚举标签 / 操耍人姓名 / 数组 / 空指派） */
function makeFormatter(plan: MergePlan) {
  const operators = new Map<string, PackageOperator>();
  plan.changes.operators.forEach((change) => {
    [change.local, change.remote, change.base].forEach((row) => {
      if (row) operators.set(row.operatorCode, row);
    });
  });
  const operatorName = (code: unknown): string => {
    if (code === null || code === undefined || code === '') return '待指派（空）';
    const op = operators.get(code as string);
    return op ? op.name : `（已撤/未知 ${String(code)}）`;
  };
  return function formatValue(conflict: FieldConflict, value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return conflict.field === 'operatorCode' || conflict.field === 'leadOperatorCode' ? '待指派（空）' : '（空）';
    }
    switch (conflict.field) {
      case 'genre':
        return PLAY_GENRE_LABEL[value as keyof typeof PLAY_GENRE_LABEL] ?? String(value);
      case 'status':
        return PLAY_STATUS_LABEL[value as keyof typeof PLAY_STATUS_LABEL] ?? String(value);
      case 'roleType':
        return ROLE_TYPE_LABEL[value as keyof typeof ROLE_TYPE_LABEL] ?? String(value);
      case 'needsShadowScreen':
        return SHADOW_SCREEN_LABEL[value as keyof typeof SHADOW_SCREEN_LABEL] ?? String(value);
      case 'beatName':
        return BEAT_NAME_LABEL[value as keyof typeof BEAT_NAME_LABEL] ?? String(value);
      case 'instrument':
        return INSTRUMENT_LABEL[value as keyof typeof INSTRUMENT_LABEL] ?? String(value);
      case 'propParts':
        return (value as string[]).map((part) => PROP_PART_LABEL[part as keyof typeof PROP_PART_LABEL] ?? part).join('、') || '无需拆件';
      case 'skillTags':
        return (value as string[]).map((tag) => SKILL_TAG_LABEL[tag as keyof typeof SKILL_TAG_LABEL] ?? tag).join('、') || '无';
      case 'operatorCode':
      case 'leadOperatorCode':
        return operatorName(value);
      case 'weekday':
        return WEEKDAY_LABEL[value as keyof typeof WEEKDAY_LABEL] ?? String(value);
      case 'startMinute':
        return minuteToClock(value as number);
      case 'durationMinute':
        return `${String(value)} 分钟`;
      case 'atSecond':
        return `${secondsToTimecode(value as number)}（${String(value)} 秒）`;
      default:
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  };
}

const ENTITY_GROUP_LABEL: Record<string, string> = {
  play: '剧目',
  scene: '场次',
  role: '影人角色',
  cue: '锣鼓点',
  operator: '操耍人',
  slot: '档期时段',
};

export default function MergeReview() {
  const { id: sessionId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [session, setSession] = useState<MergeSessionRow | null>(null);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [resolutions, setResolutions] = useState<ResolutionMap>({});
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPlays = usePlayStore((state) => state.loadPlays);
  const plays = usePlayStore((state) => state.plays);
  const loadOperators = useOperatorStore((state) => state.loadOperators);

  const reload = useCallback(async () => {
    const row = await getMergeSession(sessionId);
    if (!row) {
      setLoadError('合并会话不存在（可能已被丢弃）');
      return;
    }
    const { plan: freshPlan } = await recomputePlan(row);
    setSession(row);
    setPlan(freshPlan);
    setResolutions(row.resolutions ?? {});
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 选择变化后自动保存（防抖 400ms），失败重试时进度仍在
  const scheduleSave = useCallback(
    (next: ResolutionMap) => {
      if (!session || session.status === 'applied') return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setSaving(true);
        saveResolutions(session.id, next)
          .then((saved) => setSession(saved))
          .catch((error: unknown) =>
            message.error(`核对进度保存失败：${error instanceof Error ? error.message : '未知错误'}`),
          )
          .finally(() => setSaving(false));
      }, 400);
    },
    [session, message],
  );

  const choose = (conflictId: string, choice: Choice): void => {
    if (!choice) return;
    const next = { ...resolutions, [conflictId]: choice };
    setResolutions(next);
    scheduleSave(next);
  };

  const formatValue = useMemo(() => (plan ? makeFormatter(plan) : null), [plan]);

  const resolved = plan ? isPlanResolved(plan, resolutions) : false;
  const stats = useMemo(() => (plan ? planStats(plan) : null), [plan]);
  const unresolvedFields = plan?.conflicts.filter(
    (c) => resolutions[c.id] !== 'local' && resolutions[c.id] !== 'remote',
  ).length ?? 0;
  const unresolvedEntities = plan?.entityConflicts.filter(
    (c) => resolutions[c.id] !== 'keep' && resolutions[c.id] !== 'delete',
  ).length ?? 0;

  const handleApply = async (): Promise<void> => {
    if (!session) return;
    setApplying(true);
    try {
      const { session: done } = await applyMerge(session.id, resolutions);
      setSession(done);
      message.success('合并已落盘，剧目库与操耍人档已更新');
      await Promise.all([loadPlays(), loadOperators()]);
      const { plan: finalPlan } = await recomputePlan(done);
      setPlan(finalPlan);
    } catch (error) {
      if (error instanceof UnresolvedConflictsError) {
        message.warning(`还有 ${error.remaining} 处冲突未选定，先核对完再写入`);
      } else {
        message.error(`合并写入失败，整包与进度已保留，可直接重试：${error instanceof Error ? error.message : '未知错误'}`);
      }
      await reload();
    } finally {
      setApplying(false);
    }
  };

  if (loadError) {
    return <Empty description={loadError} style={{ marginTop: 80 }}>
      <Button type="primary" onClick={() => navigate('/merges')}>返回合并台</Button>
    </Empty>;
  }
  if (!session || !plan || !formatValue) {
    return <div className="gb-panel" style={{ padding: 40, textAlign: 'center' }}>正在重建合并方案…</div>;
  }

  // 已落盘：只读结果
  if (session.status === 'applied' && session.report) {
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Result
          status="success"
          title="排演包已合并落盘"
          subTitle={`${plan.packageLabel} · ${session.brigadeName} · 落盘于 ${formatStamp(session.report.appliedAt)}`}
          extra={[
            <Button
              type="primary"
              key="plays"
              onClick={() => {
                const target = plays.find((play) => play.playCode === session.playCode);
                navigate(target ? ROUTES.scenes(target.id) : ROUTES.plays);
              }}
            >
              查看最终场次
            </Button>,
            <Button key="merges" onClick={() => navigate('/merges')}>返回合并台</Button>,
          ]}
        />
        <ReportCard session={session} />
      </Space>
    );
  }

  // 分组字段冲突
  const fieldGroups = new Map<string, FieldConflict[]>();
  plan.conflicts.forEach((conflict) => {
    const list = fieldGroups.get(conflict.entity) ?? [];
    list.push(conflict);
    fieldGroups.set(conflict.entity, list);
  });

  const renderFieldConflict = (conflict: FieldConflict) => {
    const picked = resolutions[conflict.id];
    const localPicked = picked === 'local';
    const remotePicked = picked === 'remote';
    const sideCard = (which: string, value: unknown, active: boolean, onPick: () => void) => (
      <Card
        size="small"
        hoverable
        onClick={onPick}
        style={{
          flex: 1,
          cursor: 'pointer',
          borderColor: active ? '#7a1f1f' : undefined,
          borderWidth: active ? 2 : 1,
          background: active ? '#fff8f6' : undefined,
        }}
        title={
          <Space size={6}>
            <Radio checked={active} onChange={onPick} onClick={(e) => e.stopPropagation()} />
            <Typography.Text strong>{which}</Typography.Text>
          </Space>
        }
      >
        <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {formatValue(conflict, value)}
        </Typography.Paragraph>
      </Card>
    );
    return (
      <Card key={conflict.id} size="small" style={{ marginBottom: 10 }}>
        <Space style={{ marginBottom: 8 }}>
          <Tag color="gold">{conflict.fieldLabel}</Tag>
          <Typography.Text type="secondary">{conflict.entityLabel}</Typography.Text>
          {!picked ? <Tag icon={<WarningOutlined />} color="error">待选定</Tag> : <Tag color="success">已选定</Tag>}
        </Space>
        <Space.Compact style={{ width: '100%' }}>
          {sideCard('本机（班社）', conflict.localValue, localPicked, () => choose(conflict.id, 'local'))}
          {sideCard(`分队（${plan.brigadeName}）`, conflict.remoteValue, remotePicked, () => choose(conflict.id, 'remote'))}
        </Space.Compact>
      </Card>
    );
  };

  const renderEntityConflict = (conflict: EntityConflict) => {
    const picked = resolutions[conflict.id];
    const remoteDeleted = conflict.kind === 'remote-delete-local-modified';
    return (
      <Card key={conflict.id} size="small" style={{ marginBottom: 10 }}>
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Space>
            <Tag color={remoteDeleted ? 'error' : 'warning'}>
              {remoteDeleted ? '分队撤掉 / 本机改过' : '本机撤掉 / 分队改过'}
            </Tag>
            <Typography.Text strong>{conflict.entityLabel}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {ENTITY_GROUP_LABEL[conflict.entity]} · 编号 {conflict.code}
            </Typography.Text>
          </Space>
          <Radio.Group
            value={picked}
            onChange={(event) => choose(conflict.id, event.target.value as Choice)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="keep">
              <SaveOutlined /> 保留改动
            </Radio.Button>
            <Radio.Button value="delete">
              <DeleteOutlined /> 听从撤掉
            </Radio.Button>
          </Radio.Group>
          {conflict.entity === 'scene' && picked === 'delete' && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              撤场后该场影人角色指派与锣鼓点会一并处理干净。
            </Typography.Text>
          )}
          {conflict.entity === 'operator' && picked === 'delete' && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              撤人后相关角色指派与锣鼓点领奏会解绑（待重派）。
            </Typography.Text>
          )}
        </Space>
      </Card>
    );
  };

  const changeGroups: Array<{ key: string; label: string; rows: Array<{ label: string; action: string }> }> = [
    {
      key: 'scenes',
      label: '场次',
      rows: plan.changes.scenes
        .filter((c) => c.action !== 'unchanged')
        .map((c) => ({ label: c.entityLabel, action: c.action })),
    },
    {
      key: 'roles',
      label: '影人角色',
      rows: plan.changes.roles.filter((c) => c.action !== 'unchanged').map((c) => ({ label: c.entityLabel, action: c.action })),
    },
    {
      key: 'cues',
      label: '锣鼓点',
      rows: plan.changes.cues.filter((c) => c.action !== 'unchanged').map((c) => ({ label: c.entityLabel, action: c.action })),
    },
    {
      key: 'operators',
      label: '操耍人',
      rows: plan.changes.operators.filter((c) => c.action !== 'unchanged').map((c) => ({ label: c.entityLabel, action: c.action })),
    },
    {
      key: 'slots',
      label: '档期时段',
      rows: plan.changes.slots.filter((c) => c.action !== 'unchanged').map((c) => {
        const op = plan.changes.operators.find((o) => o.code === c.operatorCode);
        const slot = c.local ?? c.remote ?? c.base;
        return { label: `${op?.entityLabel ?? c.operatorCode} · ${slot?.label ?? c.slotCode}`, action: c.action };
      }),
    },
  ];

  const actionTag = (action: string) => {
    if (action === 'add') return <Tag color="success">新增</Tag>;
    if (action === 'update') return <Tag color="processing">修改</Tag>;
    if (action === 'delete') return <Tag color="error">撤掉</Tag>;
    return <Tag>不变</Tag>;
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-brand-bar" />
        <div className="gb-panel-title">
          <div>
            <Space>
              <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate('/merges')}>合并台</Button>
              <Typography.Title level={4} style={{ margin: 0 }}>
                核对冲突 · {plan.packageLabel}
              </Typography.Title>
            </Space>
            <Typography.Text type="secondary">
              {plan.brigadeName} 分队 · 打包于 {formatStamp(plan.exportedAt)} · 包号 {plan.packageCode}
            </Typography.Text>
          </div>
          <Space direction="vertical" align="end">
            <Space>
              <Tag icon={<SaveOutlined />} color={saving ? 'processing' : 'default'}>
                {saving ? '进度保存中…' : '进度自动保存'}
              </Tag>
              {session.status === 'failed' ? <Tag color="error">上次写入失败 · 可重试</Tag> : null}
            </Space>
            <Button
              type="primary"
              size="large"
              icon={session.status === 'failed' ? <RetweetOutlined /> : <CloudUploadOutlined />}
              loading={applying}
              disabled={!resolved}
              onClick={() => void handleApply()}
            >
              {resolved ? '选定无误，一起写入剧目' : `还有 ${unresolvedFields + unresolvedEntities} 处待选`}
            </Button>
          </Space>
        </div>

        {plan.baselineMigrated ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="旧包缺少上次交接底稿"
            description="已按本机当前记录迁移补齐为底稿后再合并：本机改动不会误判为冲突；因无法证明分队撤掉了什么，本次只吸收包内新增与可确认的改动，不删除本机数据。"
          />
        ) : null}
        {session.errorMessage ? (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 12 }}
            message={`上次写入失败：${session.errorMessage}`}
            description="整包与已核对进度都保留着，修正后点上方按钮重试即可，不会重复追加。"
          />
        ) : null}
      </div>

      <Row gutter={16}>
        <Col xs={12} md={5}>
          <Card><Statistic title="新增" value={stats?.adds ?? 0} valueStyle={{ color: '#389e0d' }} /></Card>
        </Col>
        <Col xs={12} md={5}>
          <Card><Statistic title="修改" value={stats?.updates ?? 0} valueStyle={{ color: '#1d6fb8' }} /></Card>
        </Col>
        <Col xs={12} md={5}>
          <Card><Statistic title="撤掉" value={stats?.deletes ?? 0} valueStyle={{ color: '#cf1322' }} /></Card>
        </Col>
        <Col xs={12} md={5}>
          <Card><Statistic title="字段冲突" value={unresolvedFields} suffix={`/ 共 ${plan.conflicts.length}`} valueStyle={{ color: unresolvedFields ? '#d48806' : undefined }} /></Card>
        </Col>
        <Col xs={12} md={4}>
          <Card><Statistic title="去留冲突" value={unresolvedEntities} suffix={`/ 共 ${plan.entityConflicts.length}`} valueStyle={{ color: unresolvedEntities ? '#d48806' : undefined }} /></Card>
        </Col>
      </Row>

      {resolved ? (
        <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="冲突已全部选定，可以写入剧目。" />
      ) : (
        <Alert type="info" showIcon message="同一字段两边改过时，两版并列保留；逐条选定采用哪一边，未选定不会写入。" />
      )}

      <Tabs
        defaultActiveKey="fields"
        items={[
          {
            key: 'fields',
            label: `字段冲突（${plan.conflicts.length}）`,
            children:
              plan.conflicts.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有字段级两边同改，无需逐项选定" />
              ) : (
                [...fieldGroups.entries()].map(([entity, list]) => (
                  <div key={entity} style={{ marginBottom: 16 }}>
                    <Typography.Title level={5}>{ENTITY_GROUP_LABEL[entity]}</Typography.Title>
                    {list.map(renderFieldConflict)}
                  </div>
                ))
              ),
          },
          {
            key: 'entities',
            label: `去留冲突（${plan.entityConflicts.length}）`,
            children:
              plan.entityConflicts.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有一边撤、一边改的去留分歧" />
              ) : (
                plan.entityConflicts.map(renderEntityConflict)
              ),
          },
          {
            key: 'changes',
            label: '变更清单与级联',
            children: (
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                {plan.warnings.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="撤场 / 撤人时的级联处理"
                    description={
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {plan.warnings
                          .filter((w) => w.level === 'warning')
                          .map((w) => (
                            <li key={w.id}>{w.message}</li>
                          ))}
                      </ul>
                    }
                  />
                ) : null}
                <Row gutter={[12, 12]}>
                  {changeGroups.map((group) => (
                    <Col xs={24} md={12} key={group.key}>
                      <Card size="small" title={`${group.label}（${group.rows.length} 项变动）`}>
                        {group.rows.length === 0 ? (
                          <Typography.Text type="secondary">无</Typography.Text>
                        ) : (
                          <Space direction="vertical" size={4} style={{ width: '100%' }}>
                            {group.rows.map((row, index) => (
                              <Space key={`${row.label}-${index}`}>
                                {actionTag(row.action)}
                                <Typography.Text>{row.label}</Typography.Text>
                              </Space>
                            ))}
                          </Space>
                        )}
                      </Card>
                    </Col>
                  ))}
                </Row>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

/** 已落盘结果卡片 */
function ReportCard({ session }: { session: MergeSessionRow }) {
  const report = session.report;
  if (!report) return null;
  return (
    <div className="gb-panel">
      <Descriptions title="落盘汇报" column={3} bordered size="small">
        <Descriptions.Item label="新增">{report.adds}</Descriptions.Item>
        <Descriptions.Item label="修改">{report.updates}</Descriptions.Item>
        <Descriptions.Item label="撤掉">{report.deletes}</Descriptions.Item>
        <Descriptions.Item label="字段冲突">{report.fieldConflicts}</Descriptions.Item>
        <Descriptions.Item label="去留冲突">{report.entityConflicts}</Descriptions.Item>
        <Descriptions.Item label="底稿迁移">{report.baselineMigrated ? '是（旧包补齐）' : '否'}</Descriptions.Item>
      </Descriptions>
      {report.warnings.length > 0 ? (
        <Space direction="vertical" size={2} style={{ marginTop: 12 }}>
          {report.warnings.map((text) => (
            <Typography.Text key={text} type="warning" style={{ fontSize: 12 }}>
              <WarningOutlined /> {text}
            </Typography.Text>
          ))}
        </Space>
      ) : null}
    </div>
  );
}
