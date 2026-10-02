/**
 * /scenes/:id/cues 锣鼓点时间轴
 * 按时秒插入鼓点并试排播放时间轴刻度；消费 PercussionCue、Scene，复用 <SceneCard>。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  EditOutlined,
  PauseOutlined,
  PlusOutlined,
  ReloadOutlined,
  SoundOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { SceneCard } from '../components/common/SceneCard';
import { EmptyState } from '../components/common/EmptyState';
import { useSceneOrder } from '../hooks/useSceneOrder';
import { useOperatorStore, operatorNameOf } from '../stores/operatorStore';
import { useSceneStore } from '../stores/sceneStore';
import { SKILL_TAG_LABEL } from '../types/operator';
import { usePlayStore } from '../stores/playStore';
import { ROUTES } from '../router';
import {
  BEAT_DENSITY,
  BEAT_NAME_LABEL,
  BEAT_NAME_OPTIONS,
  INSTRUMENT_COLOR,
  INSTRUMENT_LABEL,
  INSTRUMENT_OPTIONS,
  createEmptyCueDraft,
  type BeatName,
  type CueDraft,
} from '../types/cue';
import {
  ROW_REVISION,
  getScene,
  listCuesByScene,
  putCue,
  removeCue,
  type CueRow,
  type SceneRow,
} from '../utils/db';
import { buildRulerTicks, secondsToPercent, secondsToTimecode, timecodeToSeconds } from '../utils/timecode';
import { nowIso, uuid } from '../utils/uuid';

export default function CueTimeline() {
  const { id: sceneId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<CueDraft>();

  const [scene, setScene] = useState<SceneRow | null>(null);
  const [cues, setCues] = useState<CueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursorSecond, setCursorSecond] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followCursor, setFollowCursor] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCueId, setEditingCueId] = useState<string | null>(null);
  const [activeCueId, setActiveCueId] = useState<string | null>(null);

  const operators = useOperatorStore((state) => state.operators);
  const loadOperators = useOperatorStore((state) => state.loadOperators);
  const loadScenes = useSceneStore((state) => state.loadScenes);
  const plays = usePlayStore((state) => state.plays);

  const reload = useCallback(async () => {
    setLoading(true);
    const [sceneRow, cueRows] = await Promise.all([getScene(sceneId), listCuesByScene(sceneId)]);
    setScene(sceneRow ?? null);
    setCues(cueRows);
    setLoading(false);
    if (sceneRow) {
      await Promise.all([loadScenes(sceneRow.playId), loadOperators()]);
    }
  }, [loadOperators, loadScenes, sceneId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const {
    items,
    selectedSceneIds,
    toggleSelected,
    totalMinute,
  } = useSceneOrder(scene ? scene.playId : null);

  const play = scene ? plays.find((item) => item.id === scene.playId) ?? null : null;
  const durationSecond = scene ? Math.max(1, scene.durationMin) * 60 : 60;
  const ticks = useMemo(() => buildRulerTicks(durationSecond), [durationSecond]);
  const sortedCues = useMemo(() => [...cues].sort((a, b) => a.atSecond - b.atSecond), [cues]);

  /** 试排播放：按秒推进游标，到时辰停止 */
  const lastFrameRef = useRef<number>(0);
  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    const step = (timestamp: number) => {
      if (lastFrameRef.current === 0) lastFrameRef.current = timestamp;
      const delta = (timestamp - lastFrameRef.current) / 1000;
      lastFrameRef.current = timestamp;
      setCursorSecond((prev) => {
        const next = prev + delta;
        if (next >= durationSecond) {
          setPlaying(false);
          return durationSecond;
        }
        return next;
      });
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => {
      lastFrameRef.current = 0;
      window.cancelAnimationFrame(raf);
    };
  }, [playing, durationSecond]);

  /** 播放到鼓点秒点时高亮该鼓点 */
  useEffect(() => {
    const passed = sortedCues.filter((cue) => cue.atSecond <= cursorSecond);
    const last = passed.length > 0 ? passed[passed.length - 1] : null;
    if (last && cursorSecond - last.atSecond < 1.6) {
      setActiveCueId(last.id);
    }
  }, [cursorSecond, sortedCues]);

  const rulerRef = useRef<HTMLDivElement | null>(null);

  /**
   * 试排时跟随游标：把时间轴容器横向滚动到游标附近。
   * 刻度较密时容器会横向溢出（min-width 由刻度数决定），滚动可让当前秒点始终可见。
   */
  useEffect(() => {
    if (!playing || !followCursor) return;
    const node = rulerRef.current;
    if (!node) return;
    const target = (cursorSecond / durationSecond) * node.scrollWidth;
    const view = node.clientWidth;
    if (target < node.scrollLeft || target > node.scrollLeft + view - 24) {
      node.scrollLeft = Math.max(0, target - view / 2);
    }
  }, [cursorSecond, durationSecond, followCursor, playing]);

  const seekByEvent = (clientX: number) => {
    const node = rulerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setCursorSecond(Math.round(ratio * durationSecond));
    setPlaying(false);
  };

  const openCreate = (atSecond?: number) => {
    setEditingCueId(null);
    form.setFieldsValue(createEmptyCueDraft(atSecond ?? cursorSecond) as CueDraft);
    setModalOpen(true);
  };

  const openEdit = (cue: CueRow) => {
    setEditingCueId(cue.id);
    form.setFieldsValue({
      beatName: cue.beatName,
      instrument: cue.instrument,
      atSecond: cue.atSecond,
      leadOperator: cue.leadOperator,
      note: cue.note,
    });
    setModalOpen(true);
  };

  const submitCue = async () => {
    const values = await form.validateFields();
    const stamp = nowIso();
    const atSecond = Math.max(0, Math.min(durationSecond, Math.round(values.atSecond)));
    if (editingCueId) {
      const target = cues.find((cue) => cue.id === editingCueId);
      if (target) {
        const next: CueRow = {
          ...target,
          beatName: values.beatName,
          instrument: values.instrument,
          atSecond,
          leadOperator: values.leadOperator,
          note: values.note.trim(),
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        await putCue(next);
        setCues((prev) => prev.map((cue) => (cue.id === next.id ? next : cue)));
        message.success('锣鼓点已更新');
      }
    } else {
      const row: CueRow = {
        id: uuid(),
        sceneId,
        beatName: values.beatName,
        instrument: values.instrument,
        atSecond,
        leadOperator: values.leadOperator,
        note: values.note.trim(),
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await putCue(row);
      setCues((prev) => [...prev, row]);
      message.success(`已在 ${secondsToTimecode(atSecond)} 插入「${BEAT_NAME_LABEL[row.beatName]}」`);
    }
    setModalOpen(false);
  };

  const handleDelete = (cue: CueRow) => {
    modal.confirm({
      title: `删除 ${secondsToTimecode(cue.atSecond)} 的「${BEAT_NAME_LABEL[cue.beatName]}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await removeCue(cue.id);
        setCues((prev) => prev.filter((item) => item.id !== cue.id));
        message.success('鼓点已删除');
      },
    });
  };

  const columns: ColumnsType<CueRow> = [
    {
      title: '秒点',
      dataIndex: 'atSecond',
      width: 96,
      sorter: (a, b) => a.atSecond - b.atSecond,
      defaultSortOrder: 'ascend',
      render: (value: number, record) => (
        <Space size={4}>
          <Tag color="#7a1f1f" className="gb-mono">
            {secondsToTimecode(value)}
          </Tag>
          <Tooltip title="把试排游标移到该鼓点">
            <Button
              size="small"
              type="text"
              onClick={() => {
                setCursorSecond(value);
                setPlaying(false);
              }}
            >
              <CaretRightOutlined />
            </Button>
          </Tooltip>
          {activeCueId === record.id ? <Tag color="gold">当前</Tag> : null}
        </Space>
      ),
    },
    {
      title: '锣鼓点名',
      dataIndex: 'beatName',
      width: 120,
      filters: BEAT_NAME_OPTIONS.map((option) => ({ text: option.label, value: option.value })),
      onFilter: (value, record) => record.beatName === value,
      render: (value: BeatName) => <Tag color="volcano">{BEAT_NAME_LABEL[value]}</Tag>,
    },
    {
      title: '乐器',
      dataIndex: 'instrument',
      width: 110,
      render: (value: CueRow['instrument']) => (
        <Tag color={INSTRUMENT_COLOR[value]} style={{ color: '#fffdf8' }}>
          {INSTRUMENT_LABEL[value]}
        </Tag>
      ),
    },
    {
      title: '领奏操耍人',
      dataIndex: 'leadOperator',
      width: 200,
      render: (value: string | null, record) => (
        <Select<string | null>
          size="small"
          style={{ width: '100%' }}
          value={value}
          allowClear
          placeholder="选择领奏"
          options={operators.map((operator) => ({ value: operator.id, label: operator.name }))}
          onChange={async (next) => {
            const target = cues.find((cue) => cue.id === record.id);
            if (!target) return;
            const updated: CueRow = { ...target, leadOperator: next ?? null, updatedAt: nowIso(), revision: ROW_REVISION };
            await putCue(updated);
            setCues((prev) => prev.map((cue) => (cue.id === updated.id ? updated : cue)));
          }}
        />
      ),
    },
    {
      title: '备注',
      dataIndex: 'note',
      render: (value: string, record) => (
        <Input
          size="small"
          value={value}
          placeholder="如：水漫起势 / 与铙钹同落"
          onChange={async (event) => {
            const target = cues.find((cue) => cue.id === record.id);
            if (!target) return;
            const updated: CueRow = { ...target, note: event.target.value, updatedAt: nowIso(), revision: ROW_REVISION };
            setCues((prev) => prev.map((cue) => (cue.id === updated.id ? updated : cue)));
          }}
          onBlur={async (event) => {
            const target = cues.find((cue) => cue.id === record.id);
            if (!target) return;
            await putCue({ ...target, note: event.target.value, updatedAt: nowIso(), revision: ROW_REVISION });
          }}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)} />
        </Space>
      ),
    },
  ];

  if (!loading && !scene) {
    return (
      <div className="gb-panel">
        <EmptyState
          title="未找到该场次"
          description="场次可能已随剧目删除，请回到剧目库重新选择。"
          actionText="回到剧目库"
          onAction={() => navigate(ROUTES.plays)}
        />
      </div>
    );
  }

  const sceneIndex = items.findIndex((item) => item.scene.id === sceneId);
  const prevItem = sceneIndex > 0 ? items[sceneIndex - 1] : null;
  const nextItem = sceneIndex >= 0 && sceneIndex < items.length - 1 ? items[sceneIndex + 1] : null;
  const passedCount = sortedCues.filter((cue) => cue.atSecond <= cursorSecond).length;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => scene && navigate(ROUTES.scenes(scene.playId))}>
              场次拆分
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              锣鼓点时间轴{scene ? ` · 第 ${scene.seq} 场 ${scene.title}` : ''}
            </Typography.Title>
            {play ? <Tag color="#7a1f1f">{play.title}</Tag> : null}
            <Tag color="gold">整剧合计 {totalMinute} 分钟</Tag>
          </Space>
          <Space wrap>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => openCreate()}>
              在游标处插入鼓点
            </Button>
            <Button
              icon={<TeamOutlined />}
              disabled={!scene}
              onClick={() => scene && navigate(ROUTES.roles(scene.id))}
            >
              角色指派
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
              重新载入
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="本场时长" value={scene?.durationMin ?? 0} suffix="分钟" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="锣鼓点数量" value={cues.length} suffix="处" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="试排游标" value={secondsToTimecode(cursorSecond)} className="gb-mono" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="已过鼓点" value={passedCount} suffix={`/ ${cues.length}`} />
          </Col>
        </Row>
      </div>

      <Row gutter={16}>
        <Col xs={24} lg={9}>
          <div className="gb-panel">
            <div className="gb-panel-title">
              <Typography.Text strong>本剧场序（点击切换场次时间轴）</Typography.Text>
              <Tag>{selectedSceneIds.length} 场勾选</Tag>
            </div>
            <div className="gb-scene-list">
              {items.length === 0 ? (
                <EmptyState
                  size="small"
                  title="还没有场次"
                  description="先到场次拆分页建立场次。"
                  actionText="去拆场次"
                  onAction={() => play && navigate(ROUTES.scenes(play.id))}
                />
              ) : (
                items.map((item) => (
                  <SceneCard
                    key={item.scene.id}
                    scene={item.scene}
                    startTimecode={item.startTimecode}
                    endTimecode={item.endTimecode}
                    cueCount={item.scene.id === sceneId ? cues.length : 0}
                    roleCount={0}
                    selected={selectedSceneIds.includes(item.scene.id)}
                    selectable
                    compact
                    onToggleSelect={() => toggleSelected(item.scene.id)}
                    onOpen={() => navigate(ROUTES.cues(item.scene.id))}
                    extraActions={
                      item.scene.id === sceneId ? <Tag color="#7a1f1f">当前</Tag> : undefined
                    }
                  />
                ))
              )}
            </div>
          </div>
        </Col>

        <Col xs={24} lg={15}>
          <div className="gb-panel">
            <div className="gb-panel-title">
              <Space size={10} wrap>
                <Typography.Text strong>试排时间轴刻度</Typography.Text>
                <Tag className="gb-mono">
                  {secondsToTimecode(Math.floor(cursorSecond))} / {secondsToTimecode(durationSecond)}
                </Tag>
              </Space>
              <Space wrap>
                <Button
                  type="primary"
                  icon={playing ? <PauseOutlined /> : <CaretRightOutlined />}
                  onClick={() => {
                    if (cursorSecond >= durationSecond) setCursorSecond(0);
                    setPlaying((prev) => !prev);
                  }}
                >
                  {playing ? '暂停试排' : '开始试排'}
                </Button>
                <Button
                  onClick={() => {
                    setPlaying(false);
                    setCursorSecond(0);
                  }}
                >
                  回到开头
                </Button>
                <Space size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    随游标滚动
                  </Typography.Text>
                  <Switch size="small" checked={followCursor} onChange={setFollowCursor} />
                </Space>
              </Space>
            </div>

            <div
              ref={rulerRef}
              style={{ overflowX: 'auto', overflowY: 'hidden', paddingBottom: 4 }}
            >
              <div
                className="gb-ruler"
                style={{ minWidth: Math.max(560, Math.round(durationSecond * 3.2)) }}
                onClick={(event) => seekByEvent(event.clientX)}
                title="点击刻度可定位试排游标"
              >
                {ticks.map((tick) => (
                  <div key={tick} className="gb-ruler-tick" style={{ left: `${secondsToPercent(tick, durationSecond)}%` }}>
                    <span className="gb-mono">{secondsToTimecode(tick)}</span>
                  </div>
                ))}
                {sortedCues.map((cue) => (
                  <div
                    key={cue.id}
                    className="gb-cue-dot"
                    style={{ left: `${secondsToPercent(cue.atSecond, durationSecond)}%` }}
                    onClick={(event) => {
                      event.stopPropagation();
                      openEdit(cue);
                    }}
                    title={`${secondsToTimecode(cue.atSecond)} ${BEAT_NAME_LABEL[cue.beatName]}（${
                      INSTRUMENT_LABEL[cue.instrument]
                    }）点击编辑`}
                  >
                    <b className="gb-mono">{secondsToTimecode(cue.atSecond)}</b>
                    <i
                      style={{
                        background: INSTRUMENT_COLOR[cue.instrument],
                        transform: activeCueId === cue.id ? 'scale(1.6)' : 'scale(1)',
                        transition: 'transform 0.18s ease',
                      }}
                    />
                    <span style={{ color: 'rgba(43,26,18,0.7)' }}>
                      {BEAT_NAME_LABEL[cue.beatName]}·{INSTRUMENT_LABEL[cue.instrument]}
                    </span>
                  </div>
                ))}
                <div className="gb-playhead" style={{ left: `${secondsToPercent(cursorSecond, durationSecond)}%` }} />
              </div>
            </div>

            <Space style={{ width: '100%', marginTop: 12 }} wrap>
              <Typography.Text type="secondary">游标定位</Typography.Text>
              <InputNumber
                min={0}
                max={durationSecond}
                value={Math.round(cursorSecond)}
                onChange={(value) => {
                  setPlaying(false);
                  setCursorSecond(typeof value === 'number' ? value : 0);
                }}
                addonAfter="秒"
                style={{ width: 140 }}
              />
              <Input
                style={{ width: 120 }}
                placeholder="mm:ss"
                onPressEnter={(event) => {
                  const parsed = timecodeToSeconds(event.currentTarget.value);
                  if (Number.isNaN(parsed)) {
                    message.warning('时间码格式应为 mm:ss，例如 01:20');
                    return;
                  }
                  setPlaying(false);
                  setCursorSecond(Math.min(durationSecond, parsed));
                  message.success(`游标已定位到 ${secondsToTimecode(parsed)}`);
                }}
              />
              <Button icon={<ThunderboltOutlined />} onClick={() => openCreate(Math.round(cursorSecond))}>
                在游标 {secondsToTimecode(Math.round(cursorSecond))} 插点
              </Button>
              {followCursor && sortedCues.length > 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  最近鼓点：
                  {(() => {
                    const passed = sortedCues.filter((cue) => cue.atSecond <= cursorSecond);
                    const nearest = passed.length > 0 ? passed[passed.length - 1] : null;
                    return nearest
                      ? `${secondsToTimecode(nearest.atSecond)} ${BEAT_NAME_LABEL[nearest.beatName]}（${
                          INSTRUMENT_LABEL[nearest.instrument]
                        }）`
                      : '尚未进入首个鼓点';
                  })()}
                </Typography.Text>
              ) : null}
            </Space>

            <div style={{ marginTop: 8 }}>
              <Slider
                min={0}
                max={durationSecond}
                value={Math.round(cursorSecond)}
                tooltip={{ formatter: (value) => secondsToTimecode(typeof value === 'number' ? value : 0) }}
                onChange={(value) => {
                  setPlaying(false);
                  setCursorSecond(value);
                }}
              />
            </div>
          </div>

          <div className="gb-panel" style={{ marginTop: 16 }}>
            <div className="gb-panel-title">
              <Typography.Text strong>鼓点清单（按秒点对齐场次时间轴）</Typography.Text>
              <Space size={8}>
                <Tag color="gold">共 {cues.length} 处</Tag>
                {cues.length > 0 ? (
                  <Tag>
                    平均间隔{' '}
                    {cues.length > 1
                      ? secondsToTimecode(
                          Math.round(
                            (sortedCues[sortedCues.length - 1].atSecond - sortedCues[0].atSecond) / (cues.length - 1),
                          ),
                        )
                      : '—'}
                  </Tag>
                ) : null}
              </Space>
            </div>

            {cues.length === 0 ? (
              <EmptyState
                title="本场还没有锣鼓点"
                description="点击时间轴定位秒点，再插入急急风、四击头或水底鱼，试排时可跟着刻度走。"
                actionText={`在 ${secondsToTimecode(Math.round(cursorSecond))} 插入鼓点`}
                onAction={() => openCreate(Math.round(cursorSecond))}
                extra={
                  <Space size={6} wrap>
                    {BEAT_NAME_OPTIONS.map((option) => (
                      <Tag key={option.value} color="volcano">
                        {option.label} · 约 {BEAT_DENSITY[option.value]} 拍/分
                      </Tag>
                    ))}
                  </Space>
                }
              />
            ) : (
              <Table<CueRow>
                rowKey="id"
                size="small"
                className="gb-table-compact"
                loading={loading}
                columns={columns}
                dataSource={sortedCues}
                pagination={false}
                rowClassName={(record) => (activeCueId === record.id ? 'gb-row-active' : '')}
                locale={{ emptyText: <Empty description="暂无鼓点" /> }}
              />
            )}
          </div>

          <div className="gb-panel" style={{ marginTop: 16 }}>
            <Row gutter={12}>
              <Col xs={24} md={12}>
                <Card size="small" title="场次衔接">
                  <Space wrap>
                    <Button
                      icon={<ArrowLeftOutlined />}
                      disabled={!prevItem}
                      onClick={() => prevItem && navigate(ROUTES.cues(prevItem.scene.id))}
                    >
                      上一场{prevItem ? `：${prevItem.scene.title}` : ''}
                    </Button>
                    <Button
                      icon={<ArrowRightOutlined />}
                      disabled={!nextItem}
                      onClick={() => nextItem && navigate(ROUTES.cues(nextItem.scene.id))}
                    >
                      下一场{nextItem ? `：${nextItem.scene.title}` : ''}
                    </Button>
                  </Space>
                  <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
                    本场自 {secondsToTimecode(0)} 起算，上一场收在{' '}
                    {prevItem ? secondsToTimecode(prevItem.startSecond + prevItem.durationSecond) : '—'}；
                    整剧累计 {totalMinute} 分钟。
                  </Typography.Paragraph>
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title="领奏分工">
                  {operators.length === 0 ? (
                    <Empty description="操耍人档为空" />
                  ) : (
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      {operators.map((operator) => {
                        const leadCount = sortedCues.filter((cue) => cue.leadOperator === operator.id).length;
                        return (
                          <Space key={operator.id} size={8} wrap>
                            <Tag color={leadCount > 0 ? '#7a1f1f' : 'default'}>{operator.name}</Tag>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              领奏 {leadCount} 处
                            </Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              技能：
                              {operator.skillTags.length > 0 ? operator.skillTags.map((tag) => SKILL_TAG_LABEL[tag]).join('／') : '未标注'}
                            </Typography.Text>
                          </Space>
                        );
                      })}
                    </Space>
                  )}
                </Card>
              </Col>
            </Row>
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              icon={<SoundOutlined />}
              message={`当前游标 ${secondsToTimecode(Math.floor(cursorSecond))}：${
                sortedCues.filter((cue) => cue.atSecond <= cursorSecond).length
              } 处鼓点已过，剩余 ${
                sortedCues.filter((cue) => cue.atSecond > cursorSecond).length
              } 处待走。`}
              description={
                sortedCues.filter((cue) => cue.atSecond > cursorSecond).length > 0
                  ? `下一处：${secondsToTimecode(
                      sortedCues.filter((cue) => cue.atSecond > cursorSecond)[0].atSecond,
                    )} ${
                      BEAT_NAME_LABEL[sortedCues.filter((cue) => cue.atSecond > cursorSecond)[0].beatName]
                    }，领奏 ${
                      operatorNameOf(
                        operators,
                        sortedCues.filter((cue) => cue.atSecond > cursorSecond)[0].leadOperator,
                      )
                    }。`
                  : '本场鼓点已全部走完，可继续下一场编排。'
              }
            />
          </div>
        </Col>
      </Row>

      <Modal
        open={modalOpen}
        title={editingCueId ? '编辑锣鼓点' : `插入锣鼓点（${secondsToTimecode(cursorSecond)} 附近）`}
        okText={editingCueId ? '保存' : '插入'}
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        onOk={() => void submitCue()}
      >
        <Form form={form} layout="vertical" initialValues={createEmptyCueDraft(cursorSecond) as CueDraft}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="beatName" label="锣鼓点名" rules={[{ required: true, message: '请选择锣鼓点' }]}>
                <Select options={[...BEAT_NAME_OPTIONS]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="instrument" label="主奏乐器" rules={[{ required: true, message: '请选择乐器' }]}>
                <Select options={[...INSTRUMENT_OPTIONS]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="atSecond"
            label={`出场秒点（本场 0 - ${durationSecond} 秒）`}
            rules={[{ required: true, message: '请填写秒点' }]}
          >
            <InputNumber min={0} max={durationSecond} style={{ width: '100%' }} addonAfter="秒" />
          </Form.Item>
          <Form.Item name="leadOperator" label="领奏操耍人">
            <Select
              allowClear
              placeholder="可稍后再指定"
              options={operators.map((operator) => ({
                value: operator.id,
                label: `${operator.name}（已派 ${operator.assignedRoleIds.length} 个角色）`,
              }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注" rules={[{ max: 80, message: '不超过 80 个字' }]}>
            <Input.TextArea rows={3} placeholder="如：法海逼近，急急风催台" maxLength={80} showCount />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            提示：急急风适合开打与催台，四击头用于亮相，水底鱼多作垫场与转场。
          </Typography.Text>
        </Form>
      </Modal>
    </Space>
  );
}
