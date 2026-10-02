/**
 * /merges 合并台
 * 分队排演包回收口：导入 .rpk.json → 建立合并会话（含失败重试）→ 进入冲突核对。
 * 同一 packageCode 再导入：复用原会话，整包与已核对进度保留，不重复追加。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App,
  Badge,
  Button,
  Empty,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  InboxOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { listMergeSessions, type MergeSessionRow } from '../utils/db';
import { discardSession, openSessionForPackage } from '../utils/mergeService';
import { parseRehearsalPackage } from '../utils/packageIO';
import { formatStamp } from '../utils/uuid';
import { ROUTES } from '../router';

const STATUS_BADGE: Record<MergeSessionRow['status'], { badge: 'success' | 'error' | 'processing'; text: string }> = {
  pending: { badge: 'processing', text: '待核对' },
  failed: { badge: 'error', text: '上次失败 · 可重试' },
  applied: { badge: 'success', text: '已合并落盘' },
};

export default function MergeCenter() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sessions, setSessions] = useState<MergeSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const reload = async (): Promise<void> => {
    setLoading(true);
    try {
      setSessions(await listMergeSessions());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const handleFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const text = await file.text();
      const { pkg, issues } = parseRehearsalPackage(text);
      const errors = issues.filter((issue) => issue.level === 'error');
      const warnings = issues.filter((issue) => issue.level === 'warning');
      warnings.forEach((issue) => message.warning(issue.message));
      if (errors.length > 0 || !pkg) {
        message.error(errors[0]?.message ?? '排演包无法识别');
        return;
      }
      const { session, reused } = await openSessionForPackage(pkg);
      if (session.status === 'applied') {
        message.info('同一排演包此前已合并落盘，未重复追加');
      } else if (reused) {
        message.success('同一排演包已有核对会话，已保留此前核对进度');
      } else {
        message.success(`已接收「${pkg.brigadeName}」的排演包，请核对冲突`);
      }
      await reload();
      if (session.status !== 'applied') navigate(`/merges/${session.id}`);
    } catch (error) {
      message.error(`排演包接收失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setImporting(false);
    }
  };

  const columns: ColumnsType<MergeSessionRow> = [
    {
      title: '剧目 / 分队',
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{row.packageJson.current.play.title}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.brigadeName} · 打包于 {formatStamp(row.packageJson.exportedAt)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '包编号',
      dataIndex: 'packageCode',
      render: (code: string) => <Typography.Text code style={{ fontSize: 12 }}>{code}</Typography.Text>,
    },
    {
      title: '底稿',
      width: 130,
      render: (_, row) =>
        row.packageJson.base ? <Tag color="blue">带交接底稿</Tag> : <Tag color="orange">缺底稿·迁移补齐</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (status: MergeSessionRow['status']) => (
        <Badge status={STATUS_BADGE[status].badge} text={STATUS_BADGE[status].text} />
      ),
    },
    {
      title: '落盘结果',
      width: 230,
      render: (_, row) =>
        row.report ? (
          <Space size={4} wrap>
            <Tag icon={<CheckCircleOutlined />} color="success">新增 {row.report.adds}</Tag>
            <Tag color="processing">改 {row.report.updates}</Tag>
            <Tag>删 {row.report.deletes}</Tag>
            <Tag color={row.report.fieldConflicts > 0 ? 'gold' : 'default'}>字段冲突 {row.report.fieldConflicts}</Tag>
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.errorMessage ? `失败原因：${row.errorMessage}` : '尚未落盘'}
          </Typography.Text>
        ),
    },
    {
      title: '操作',
      width: 170,
      render: (_, row) => (
        <Space>
          {row.status === 'applied' ? (
            <Button size="small" onClick={() => navigate(ROUTES.plays)}>查看剧目库</Button>
          ) : (
            <Button
              size="small"
              type="primary"
              icon={<FileSearchOutlined />}
              onClick={() => navigate(`/merges/${row.id}`)}
            >
              {row.status === 'failed' ? '继续核对 / 重试' : '核对冲突'}
            </Button>
          )}
          <Popconfirm
            title="丢弃该合并会话？"
            description="整包与核对进度都会删除（不影响已落盘数据）。"
            okText="丢弃"
            cancelText="取消"
            onConfirm={async () => {
              await discardSession(row.id);
              message.success('会话已丢弃');
              void reload();
            }}
          >
            <Button size="small" danger type="text">丢弃</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-brand-bar" />
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              合并台 · 分队排演包回收
            </Typography.Title>
            <Typography.Text type="secondary">
              按剧目 / 场次 / 影人角色 / 操耍人的业务编号认关系，本机编号不同也不会硬套；
              字段两边改时并列保留，选定后一起写入
            </Typography.Text>
          </div>
          <Space wrap>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              接收排演包
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message="失败可重试：同一排演包重复导入会复用原会话，已核对进度与整包都保留，落盘成功也不会重复追加。"
        />
      </div>

      <div className="gb-panel">
        {sessions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>还没有待合并的排演包</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  分队在「场次拆分」页点「导出排演包」，回到班社后在此接收。
                </Typography.Text>
              </Space>
            }
          >
            <Button type="primary" icon={<InboxOutlined />} onClick={() => fileInputRef.current?.click()}>
              选择排演包文件
            </Button>
          </Empty>
        ) : (
          <Table<MergeSessionRow>
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={sessions}
            pagination={false}
            expandable={{
              expandedRowRender: (row) => (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {row.packageJson.note ? (
                    <Typography.Text type="secondary">分队备注：{row.packageJson.note}</Typography.Text>
                  ) : null}
                  {row.report?.warnings.length ? (
                    <Space direction="vertical" size={2}>
                      {row.report.warnings.map((text) => (
                        <Typography.Text key={text} type="warning" style={{ fontSize: 12 }}>
                          <ExclamationCircleOutlined /> {text}
                        </Typography.Text>
                      ))}
                    </Space>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    会话建立 {formatStamp(row.createdAt)} · 最近更新 {formatStamp(row.updatedAt)}
                  </Typography.Text>
                </Space>
              ),
            }}
          />
        )}
      </div>

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
