/**
 * /scenes/:id/roles 角色与操耍人指派
 * 影件备料勾选、唱白要点录入；消费 ShadowRole、Operator，复用 <AssigneePicker>。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Col,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SoundOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { AssigneePicker, type AssigneeOption } from '../components/common/AssigneePicker';
import { EmptyState } from '../components/common/EmptyState';
import { useOperatorConflict } from '../hooks/useOperatorConflict';
import { useOperatorStore } from '../stores/operatorStore';
import { useSceneStore } from '../stores/sceneStore';
import { usePlayStore } from '../stores/playStore';
import { ROUTES } from '../router';
import {
  PROP_PART_LABEL,
  PROP_PART_OPTIONS,
  ROLE_TYPE_COLOR,
  ROLE_TYPE_LABEL,
  ROLE_TYPE_OPTIONS,
  createEmptyRoleDraft,
  type PropPart,
  type RoleDraft,
  type RoleType,
} from '../types/role';
import { SHADOW_SCREEN_LABEL } from '../types/scene';
import {
  ROW_REVISION,
  getScene,
  listRolesByScene,
  putRole,
  removeRole,
  type RoleRow,
  type SceneRow,
} from '../utils/db';
import { nowIso, uuid } from '../utils/uuid';

export default function RoleAssign() {
  const { id: sceneId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<RoleDraft>();

  const [scene, setScene] = useState<SceneRow | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const operators = useOperatorStore((state) => state.operators);
  const loadOperators = useOperatorStore((state) => state.loadOperators);
  const scenes = useSceneStore((state) => state.scenes);
  const loadScenes = useSceneStore((state) => state.loadScenes);
  const plays = usePlayStore((state) => state.plays);

  const roleIds = useMemo(() => roles.map((role) => role.id), [roles]);
  const conflict = useOperatorConflict(roleIds);

  const reload = useCallback(async () => {
    setLoading(true);
    const [sceneRow, roleRows] = await Promise.all([
      getScene(sceneId),
      listRolesByScene(sceneId),
    ]);
    setScene(sceneRow ?? null);
    setRoles(roleRows);
    setLoading(false);
    if (sceneRow) {
      await Promise.all([loadScenes(sceneRow.playId), loadOperators()]);
    }
  }, [loadOperators, loadScenes, sceneId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const play = scene ? plays.find((item) => item.id === scene.playId) ?? null : null;
  const siblingScenes = scene ? scenes.filter((item) => item.playId === scene.playId).sort((a, b) => a.seq - b.seq) : [];
  const currentIndex = scene ? siblingScenes.findIndex((item) => item.id === scene.id) : -1;
  const prevScene = currentIndex > 0 ? siblingScenes[currentIndex - 1] : null;
  const nextScene = currentIndex >= 0 && currentIndex < siblingScenes.length - 1 ? siblingScenes[currentIndex + 1] : null;

  const assignedCount = roles.filter((role) => role.operatorId !== null).length;
  const propPartTotal = roles.reduce((acc, role) => acc + role.propParts.length, 0);

  /** 每个角色的候选操耍人（含冲突评估），供 <AssigneePicker> 使用 */
  const optionsFor = useCallback(
    (roleId: string): AssigneeOption[] =>
      operators.map((operator) => ({
        operator,
        assessment: conflict.assess(roleId, operator.id),
        assignedCount: operator.assignedRoleIds.length,
      })),
    [conflict, operators],
  );

  const patchRole = async (roleId: string, patch: Partial<Omit<RoleRow, 'id' | 'sceneId' | 'createdAt'>>) => {
    const target = roles.find((role) => role.id === roleId);
    if (!target) return;
    const next: RoleRow = { ...target, ...patch, updatedAt: nowIso(), revision: ROW_REVISION };
    await putRole(next);
    setRoles((prev) => prev.map((role) => (role.id === roleId ? next : role)));
  };

  const handleCreate = async () => {
    const values = await form.validateFields();
    const row: RoleRow = {
      id: uuid(),
      sceneId,
      name: values.name.trim(),
      roleType: values.roleType,
      propParts: [...values.propParts],
      entranceCue: values.entranceCue.trim(),
      lineNote: values.lineNote.trim(),
      operatorId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await putRole(row);
    setRoles((prev) => [...prev, row]);
    setModalOpen(false);
    form.resetFields();
    message.success(`已新增影人角色「${row.name}」，请指派操耍人`);
  };

  const handleDelete = (role: RoleRow) => {
    modal.confirm({
      title: `删除影人角色「${role.name}」？`,
      content: '删除后该角色的操耍人绑定一并解除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await removeRole(role.id);
        setRoles((prev) => prev.filter((item) => item.id !== role.id));
        await loadOperators();
        message.success('角色已删除');
      },
    });
  };

  const handleBind = async (roleId: string, operatorId: string) => {
    const assessment = conflict.assess(roleId, operatorId);
    if (!assessment.assignable) {
      message.warning(assessment.blockReason);
      return;
    }
    const ok = await conflict.bind(roleId, operatorId);
    if (!ok) {
      message.error('指派被时段冲突拦截');
      return;
    }
    const holder = operators.find((operator) => operator.id === operatorId);
    await patchRole(roleId, { operatorId });
    message.success(`已指派给 ${holder?.name ?? '该操耍人'}`);
  };

  const handleUnbind = async (roleId: string) => {
    await conflict.unbind(roleId);
    await patchRole(roleId, { operatorId: null });
    message.success('已解绑操耍人');
  };

  const columns: ColumnsType<RoleRow> = [
    {
      title: '影人角色',
      dataIndex: 'name',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Input
            value={record.name}
            maxLength={20}
            onChange={(event) => void patchRole(record.id, { name: event.target.value })}
          />
          <Space size={4} wrap>
            <Tag color={ROLE_TYPE_COLOR[record.roleType]}>{ROLE_TYPE_LABEL[record.roleType]}</Tag>
            <Select<RoleType>
              size="small"
              value={record.roleType}
              style={{ width: 96 }}
              options={[...ROLE_TYPE_OPTIONS]}
              onChange={(value) => void patchRole(record.id, { roleType: value })}
            />
          </Space>
        </Space>
      ),
    },
    {
      title: '影件拆件部位',
      dataIndex: 'propParts',
      width: 190,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <Checkbox.Group<PropPart>
            value={record.propParts}
            options={[...PROP_PART_OPTIONS]}
            onChange={(checked) => void patchRole(record.id, { propParts: checked as PropPart[] })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已勾 {record.propParts.length} 件：
            {record.propParts.map((part) => PROP_PART_LABEL[part]).join('／') || '无需拆件'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '出场提示',
      dataIndex: 'entranceCue',
      width: 210,
      render: (_value, record) => (
        <Input.TextArea
          value={record.entranceCue}
          autoSize={{ minRows: 2, maxRows: 3 }}
          maxLength={80}
          placeholder="如：四击头落定后自影窗右侧起伞"
          onChange={(event) => void patchRole(record.id, { entranceCue: event.target.value })}
        />
      ),
    },
    {
      title: '唱白要点',
      dataIndex: 'lineNote',
      width: 220,
      render: (_value, record) => (
        <Input.TextArea
          value={record.lineNote}
          autoSize={{ minRows: 2, maxRows: 4 }}
          maxLength={140}
          placeholder="拖腔、咬字、换气等要点"
          onChange={(event) => void patchRole(record.id, { lineNote: event.target.value })}
        />
      ),
    },
    {
      title: '操耍人指派',
      dataIndex: 'operatorId',
      width: 280,
      render: (_value, record) => {
        const assessmentList = optionsFor(record.id);
        const bound = operators.find((operator) => operator.assignedRoleIds.includes(record.id));
        return (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <AssigneePicker
              value={record.operatorId}
              options={assessmentList}
              compact
              showConflictAlert={false}
              placeholder="指派操耍人"
              onChange={(operatorId) => void handleBind(record.id, operatorId)}
              onClear={() => void handleUnbind(record.id)}
              onBlocked={(reason) => message.warning(reason)}
            />
            {bound ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                现由 {bound.name} 操耍｜累计排练 {bound.rehearsalHours} 小时｜已派 {bound.assignedRoleIds.length} 个角色
              </Typography.Text>
            ) : (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                尚未指派操耍人
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Tooltip title="保存该角色的唱白要点">
            <Button
              size="small"
              icon={<SaveOutlined />}
              onClick={async () => {
                await patchRole(record.id, {});
                message.success('已保存到本地数据库');
              }}
            />
          </Tooltip>
          <Tooltip title="删除角色">
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)} />
          </Tooltip>
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => scene && navigate(ROUTES.scenes(scene.playId))}>
              场次拆分
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              角色与操耍人指派{scene ? ` · 第 ${scene.seq} 场 ${scene.title}` : ''}
            </Typography.Title>
            {play ? <Tag color="#7a1f1f">{play.title}</Tag> : null}
            {scene ? <Tag color="gold">{SHADOW_SCREEN_LABEL[scene.needsShadowScreen]}</Tag> : null}
          </Space>
          <Space wrap>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setModalOpen(true)}>
              新增影人角色
            </Button>
            <Button icon={<SoundOutlined />} disabled={!scene} onClick={() => scene && navigate(ROUTES.cues(scene.id))}>
              去排锣鼓点
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
              重新载入
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="影人角色" value={roles.length} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="已指派操耍人" value={assignedCount} suffix={`/ ${roles.length}`} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="需备影件" value={propPartTotal} suffix="件" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="操耍人档" value={operators.length} suffix="人" />
          </Col>
        </Row>

        <Alert
          style={{ marginTop: 14 }}
          type={conflict.conflicts.length > 0 ? 'error' : 'info'}
          showIcon
          message={conflict.conflictSummary}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text style={{ fontSize: 12 }}>
                指派时会按操耍人已排时段拦截冲突；需要调整档期请到「操耍人档」增删时段。
              </Typography.Text>
              {conflict.conflicts.slice(0, 3).map((pair) => (
                <Typography.Text key={`${pair.left.slotId}-${pair.right.slotId}`} type="danger" style={{ fontSize: 12 }}>
                  {pair.describe}
                </Typography.Text>
              ))}
            </Space>
          }
        />
      </div>

      <div className="gb-panel">
        {roles.length === 0 ? (
          <EmptyState
            title="本场还没有影人角色"
            description="先登记本场出场的人物影偶，再为每个角色指定操耍人并勾选需备影件。"
            actionText="新增影人角色"
            onAction={() => setModalOpen(true)}
          />
        ) : (
          <Table<RoleRow>
            rowKey="id"
            size="small"
            className="gb-table-compact"
            loading={loading}
            columns={columns}
            dataSource={roles}
            pagination={false}
            scroll={{ x: 1200 }}
            expandable={{
              expandedRowRender: (record) => {
                const assessmentList = optionsFor(record.id);
                const blocked = assessmentList.filter((option) => !option.assessment.assignable);
                return (
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Typography.Text strong>指派详情</Typography.Text>
                    <AssigneePicker
                      value={record.operatorId}
                      options={assessmentList}
                      placeholder="为该角色选择操耍人"
                      onChange={(operatorId) => void handleBind(record.id, operatorId)}
                      onClear={() => void handleUnbind(record.id)}
                      onBlocked={(reason) => message.warning(reason)}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      候选 {assessmentList.length} 人，其中 {blocked.length} 人因时段冲突被拦截。
                    </Typography.Text>
                  </Space>
                );
              },
            }}
            locale={{ emptyText: <Empty description="暂无角色" /> }}
          />
        )}
      </div>

      <div className="gb-panel">
        <Collapse
          items={[
            {
              key: 'sibling',
              label: '本剧其他场次（可直接切换继续指派）',
              children: (
                <Space wrap>
                  {siblingScenes.map((item) => (
                    <Button
                      key={item.id}
                      type={item.id === sceneId ? 'primary' : 'default'}
                      onClick={() => navigate(ROUTES.roles(item.id))}
                    >
                      第 {item.seq} 场 · {item.title}
                    </Button>
                  ))}
                </Space>
              ),
            },
          ]}
        />
        <Space style={{ marginTop: 12 }} wrap>
          <Button
            icon={<ArrowLeftOutlined />}
            disabled={!prevScene}
            onClick={() => prevScene && navigate(ROUTES.roles(prevScene.id))}
          >
            上一场{prevScene ? `：${prevScene.title}` : ''}
          </Button>
          <Button
            icon={<ArrowRightOutlined />}
            disabled={!nextScene}
            onClick={() => nextScene && navigate(ROUTES.roles(nextScene.id))}
          >
            下一场{nextScene ? `：${nextScene.title}` : ''}
          </Button>
          <Button
            icon={<SwapOutlined />}
            disabled={!prevScene || !nextScene}
            onClick={() => {
              if (prevScene) navigate(ROUTES.cues(prevScene.id));
            }}
          >
            查看上一场锣鼓点
          </Button>
        </Space>
      </div>

      <Modal
        open={modalOpen}
        title="新增影人角色"
        okText="新增"
        cancelText="取消"
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        onOk={() => void handleCreate()}
      >
        <Form form={form} layout="vertical" initialValues={createEmptyRoleDraft()}>
          <Form.Item name="name" label="角色名" rules={[{ required: true, message: '请填写角色名' }]}>
            <Input placeholder="如：白娘子" maxLength={20} />
          </Form.Item>
          <Form.Item name="roleType" label="行当" rules={[{ required: true, message: '请选择行当' }]}>
            <Select options={[...ROLE_TYPE_OPTIONS]} />
          </Form.Item>
          <Form.Item
            name="propParts"
            label="需备影件"
            rules={[{ required: true, message: '至少勾选一个影件部位' }]}
          >
            <Checkbox.Group options={[...PROP_PART_OPTIONS]} />
          </Form.Item>
          <Form.Item name="entranceCue" label="出场提示" rules={[{ max: 80, message: '不超过 80 个字' }]}>
            <Input placeholder="如：小锣三击后自左侧上场" />
          </Form.Item>
          <Form.Item name="lineNote" label="唱白要点" rules={[{ max: 140, message: '不超过 140 个字' }]}>
            <Input.TextArea rows={3} placeholder="拖腔、咬字、换气等要点" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            新增后可在表格中直接指派操耍人，行当标签会以{' '}
            {ROLE_TYPE_OPTIONS.map((option) => `${option.label}(${ROLE_TYPE_COLOR[option.value]})`).join('、')} 展示。
          </Typography.Text>
        </Form>
      </Modal>
    </Space>
  );
}
