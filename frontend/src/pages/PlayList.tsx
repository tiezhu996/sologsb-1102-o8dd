/**
 * /plays 剧目库
 * 新建剧目、按剧种与状态筛选；消费 Play，复用 <ProgressRing>、<EmptyState>。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { ProgressRing } from '../components/common/ProgressRing';
import { EmptyState } from '../components/common/EmptyState';
import { usePlayStore } from '../stores/playStore';
import { ROUTES } from '../router';
import {
  PLAY_GENRE_LABEL,
  PLAY_GENRE_OPTIONS,
  PLAY_STATUS_COLOR,
  PLAY_STATUS_LABEL,
  PLAY_STATUS_OPTIONS,
  createEmptyPlayDraft,
  type PlayDraft,
} from '../types/play';
import type { DatabaseSnapshot } from '../utils/db';
import { exportBundleJson } from '../utils/export';
import { formatStamp } from '../utils/uuid';
import { minutesToReadable } from '../utils/timecode';

interface PlayFormValues extends PlayDraft {
  title: string;
}

export default function PlayList() {
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<PlayFormValues>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const plays = usePlayStore((state) => state.plays);
  const filters = usePlayStore((state) => state.filters);
  const loading = usePlayStore((state) => state.loading);
  const error = usePlayStore((state) => state.error);
  const counts = usePlayStore((state) => state.counts);
  const currentPlayId = usePlayStore((state) => state.currentPlayId);
  const setFilters = usePlayStore((state) => state.setFilters);
  const resetFilters = usePlayStore((state) => state.resetFilters);
  const visiblePlays = usePlayStore((state) => state.visiblePlays);
  const statOf = usePlayStore((state) => state.statOf);
  const selectPlay = usePlayStore((state) => state.selectPlay);
  const createPlay = usePlayStore((state) => state.createPlay);
  const updatePlay = usePlayStore((state) => state.updatePlay);
  const deletePlay = usePlayStore((state) => state.deletePlay);
  const loadPlays = usePlayStore((state) => state.loadPlays);
  const exportAll = usePlayStore((state) => state.exportAll);
  const importAll = usePlayStore((state) => state.importAll);
  const resetAll = usePlayStore((state) => state.resetAll);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  const list = visiblePlays();
  const totalScenes = plays.reduce((acc, play) => acc + statOf(play.id).sceneCount, 0);
  const readyCount = plays.filter((play) => play.status === 'ready').length;

  const closePlayModal = () => {
    setModalOpen(false);
    form.resetFields();
  };

  const openCreate = () => {
    setEditingId(null);
    form.setFieldsValue(createEmptyPlayDraft() as PlayFormValues);
    setModalOpen(true);
  };

  const openEdit = (playId: string) => {
    const target = plays.find((play) => play.id === playId);
    if (!target) return;
    setEditingId(playId);
    form.setFieldsValue({
      title: target.title,
      genre: target.genre,
      scriptText: target.scriptText,
      premiereVenue: target.premiereVenue,
      status: target.status,
    });
    setModalOpen(true);
  };

  const submitForm = async () => {
    const values = await form.validateFields();
    if (editingId) {
      await updatePlay(editingId, {
        title: values.title.trim(),
        genre: values.genre,
        scriptText: values.scriptText.trim(),
        premiereVenue: values.premiereVenue.trim(),
        status: values.status,
      });
      message.success('剧目信息已更新');
    } else {
      const created = await createPlay(values);
      message.success('剧目已新建，可进入场次拆分');
      setModalOpen(false);
      navigate(ROUTES.scenes(created.id));
      return;
    }
    setModalOpen(false);
  };

  const confirmDelete = (playId: string, title: string) => {
    modal.confirm({
      title: `删除剧目《${title}》？`,
      content: '该剧目下的场次、影人角色与锣鼓点会一并删除，且不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        await deletePlay(playId);
        message.success('剧目已删除');
      },
    });
  };

  const handleExport = async () => {
    const snapshot = await exportAll();
    const filename = exportBundleJson(snapshot);
    message.success(`已导出本地存档：${filename}`);
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as DatabaseSnapshot;
      if (!parsed || !Array.isArray(parsed.plays)) {
        message.error('存档格式不正确，缺少 plays 列表');
        return;
      }
      modal.confirm({
        title: '导入存档会覆盖当前全部本地数据',
        content: `存档含 ${parsed.plays.length} 个剧目，导出于 ${parsed.exportedAt ?? '未知时间'}。`,
        okText: '覆盖导入',
        cancelText: '取消',
        onOk: async () => {
          await importAll(parsed);
          message.success('存档已导入');
        },
      });
    } catch (importError) {
      message.error(`读取存档失败：${importError instanceof Error ? importError.message : '文件无法解析'}`);
    }
  };

  const handleReset = () => {
    modal.confirm({
      title: '重置为示例班社数据？',
      content: '当前本地数据会被清空，并重新灌入三出示例剧目。',
      okText: '重置',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await resetAll();
        message.success('已重置为示例数据');
      },
    });
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-brand-bar" />
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              剧目库
            </Typography.Title>
            <Typography.Text type="secondary">
              建剧目 → 拆场次 → 指派影人与操耍人 → 标注锣鼓点，全部数据保存在本机浏览器
            </Typography.Text>
          </div>
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建剧目
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>
              导出存档
            </Button>
            <Button icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()}>
              导入存档
            </Button>
            <Button icon={<ReloadOutlined />} onClick={handleReset}>
              重置示例
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="剧目总数" value={plays.length} prefix={<DatabaseOutlined />} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="场次总数" value={totalScenes} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="可上演剧目" value={readyCount} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="操耍人 / 影人角色" value={`${counts.operators ?? 0} / ${counts.roles ?? 0}`} />
          </Col>
        </Row>
      </div>

      <div className="gb-panel">
        <Space wrap size={10} style={{ marginBottom: 12 }}>
          <Input
            allowClear
            style={{ width: 220 }}
            prefix={<SearchOutlined />}
            placeholder="搜索剧目名 / 提要 / 戏台"
            value={filters.keyword}
            onChange={(event) => setFilters({ keyword: event.target.value })}
          />
          <Select
            style={{ width: 150 }}
            value={filters.genre}
            onChange={(value) => setFilters({ genre: value })}
            options={[{ value: 'all' as const, label: '全部剧种' }, ...PLAY_GENRE_OPTIONS]}
          />
          <Select
            style={{ width: 150 }}
            value={filters.status}
            onChange={(value) => setFilters({ status: value })}
            options={[{ value: 'all' as const, label: '全部状态' }, ...PLAY_STATUS_OPTIONS]}
          />
          <Button onClick={resetFilters}>清除筛选</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void loadPlays()} loading={loading}>
            重新载入
          </Button>
          <Typography.Text type="secondary">共 {list.length} 个结果</Typography.Text>
        </Space>

        {plays.length === 0 ? (
          <EmptyState
            title="还没有剧目"
            description="先建一出台戏，再按场次拆分排练任务；也可以导入之前导出的本地存档。"
            actionText="新建剧目"
            onAction={openCreate}
            secondaryText="导入存档"
            onSecondary={() => fileInputRef.current?.click()}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                示例数据可在「重置示例」中一键恢复。
              </Typography.Text>
            }
          />
        ) : list.length === 0 ? (
          <Empty description="没有符合筛选条件的剧目" />
        ) : (
          <Row gutter={[16, 16]}>
            {list.map((play) => {
              const stat = statOf(play.id);
              const isCurrent = play.id === currentPlayId;
              return (
                <Col key={play.id} xs={24} sm={12} xl={8}>
                  <Card
                    hoverable
                    onClick={() => selectPlay(play.id)}
                    style={{
                      height: '100%',
                      borderColor: isCurrent ? '#7a1f1f' : undefined,
                      borderWidth: isCurrent ? 2 : 1,
                      background: isCurrent ? '#fff8f6' : undefined,
                    }}
                    title={
                      <Space size={6} wrap>
                        <Typography.Text strong>{play.title}</Typography.Text>
                        {isCurrent ? <Tag color="#7a1f1f">当前剧目</Tag> : null}
                      </Space>
                    }
                    extra={<Tag color={PLAY_STATUS_COLOR[play.status]}>{PLAY_STATUS_LABEL[play.status]}</Tag>}
                    actions={[
                      <Tooltip title="进入场次拆分" key="scenes">
                        <Button
                          type="link"
                          icon={<ExportOutlined />}
                          onClick={(event) => {
                            event.stopPropagation();
                            selectPlay(play.id);
                            navigate(ROUTES.scenes(play.id));
                          }}
                        >
                          场次
                        </Button>
                      </Tooltip>,
                      <Tooltip title="编辑剧目" key="edit">
                        <Button
                          type="link"
                          icon={<EditOutlined />}
                          onClick={(event) => {
                            event.stopPropagation();
                            openEdit(play.id);
                          }}
                        />
                      </Tooltip>,
                      <Tooltip title="删除剧目" key="delete">
                        <Button
                          type="link"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(event) => {
                            event.stopPropagation();
                            confirmDelete(play.id, play.title);
                          }}
                        />
                      </Tooltip>,
                    ]}
                  >
                    <Space align="start" size={14} style={{ width: '100%' }}>
                      <ProgressRing
                        percent={stat.averageProgress}
                        title={`${stat.averageProgress}%`}
                        tooltip={`平均排练成熟度（${stat.sceneCount} 场合计 ${minutesToReadable(stat.totalMinute)}）`}
                      />
                      <Space direction="vertical" size={4} style={{ flex: 1 }}>
                        <Space size={4} wrap>
                          <Tag color="gold">{PLAY_GENRE_LABEL[play.genre]}</Tag>
                          <Tag>共 {play.totalScenes} 场</Tag>
                          <Tag>{minutesToReadable(stat.totalMinute)}</Tag>
                        </Space>
                        <Typography.Paragraph
                          type="secondary"
                          style={{ margin: 0, fontSize: 13 }}
                          ellipsis={{ rows: 3, tooltip: play.scriptText || '暂无剧情提要' }}
                        >
                          {play.scriptText || '暂无剧情提要'}
                        </Typography.Paragraph>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          首演戏台：{play.premiereVenue || '未定'}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          更新于 {formatStamp(play.updatedAt)}
                        </Typography.Text>
                      </Space>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </div>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑剧目' : '新建剧目'}
        okText={editingId ? '保存' : '新建并拆场次'}
        cancelText="取消"
        onCancel={closePlayModal}
        onOk={() => void submitForm()}
        destroyOnClose={false}
      >
        <Form form={form} layout="vertical" initialValues={createEmptyPlayDraft()}>
          <Form.Item
            name="title"
            label="剧目名"
            rules={[{ required: true, message: '请填写剧目名' }, { max: 40, message: '不超过 40 个字' }]}
          >
            <Input placeholder="如：白蛇传·借伞" onPressEnter={() => void submitForm()} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="genre" label="剧种" rules={[{ required: true, message: '请选择剧种' }]}>
                <Select options={[...PLAY_GENRE_OPTIONS]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="筹备状态" rules={[{ required: true, message: '请选择状态' }]}>
                <Select options={[...PLAY_STATUS_OPTIONS]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="premiereVenue" label="首演戏台" rules={[{ max: 60, message: '不超过 60 个字' }]}>
            <Input placeholder="如：滦州影戏馆 · 正台" />
          </Form.Item>
          <Form.Item
            name="scriptText"
            label="剧情提要"
            rules={[{ required: true, message: '请填写剧情提要' }, { max: 400, message: '不超过 400 个字' }]}
          >
            <Input.TextArea rows={4} placeholder="写明主线、看点与影窗 / 影件的特殊要求" showCount maxLength={400} />
          </Form.Item>
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
          if (file) void handleImportFile(file);
        }}
      />
    </Space>
  );
}
