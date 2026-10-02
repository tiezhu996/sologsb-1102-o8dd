/**
 * /operators 操耍人档与时段冲突视图
 * 查看每人已派角色与排练时长；消费 Operator，复用 <AssigneePicker>、<ProgressRing>。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
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
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  AlertOutlined,
  ClockCircleOutlined,
  DownloadOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  TeamOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import { ProgressRing } from '../components/common/ProgressRing';
import { AssigneePicker, type AssigneeOption } from '../components/common/AssigneePicker';
import { EmptyState } from '../components/common/EmptyState';
import { useOperatorStore } from '../stores/operatorStore';
import { ROUTES } from '../router';
import {
  DAY_BASE_HOUR,
  SKILL_TAG_COLOR,
  SKILL_TAG_LABEL,
  SKILL_TAG_OPTIONS,
  WEEKDAY_LABEL,
  WEEKDAY_OPTIONS,
  minuteToClock,
  type BusySlot,
  type OperatorDraft,
  type SkillTag,
  type Weekday,
} from '../types/operator';
import { PROP_PART_LABEL, ROLE_TYPE_COLOR, ROLE_TYPE_LABEL } from '../types/role';
import { ROW_REVISION, listAllRoles, putOperator, type OperatorRow, type RoleRow } from '../utils/db';
import { exportOperatorCsvFile } from '../utils/export';
import { nowIso } from '../utils/uuid';
import { minutesToReadable } from '../utils/timecode';

interface SlotFormValues {
  weekday: Weekday;
  start: dayjs.Dayjs;
  durationMinute: number;
  label: string;
}

/** 时段可选节点提示（相对 08:00 基准） */
const SLOT_HINTS = ['08:00', '11:00', '14:00', '17:00'];

export default function OperatorList() {
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [operatorForm] = Form.useForm<OperatorDraft>();
  const [slotForm] = Form.useForm<SlotFormValues>();

  const operators = useOperatorStore((state) => state.operators);
  const loading = useOperatorStore((state) => state.loading);
  const error = useOperatorStore((state) => state.error);
  const loadOperators = useOperatorStore((state) => state.loadOperators);
  const createOperator = useOperatorStore((state) => state.createOperator);
  const deleteOperator = useOperatorStore((state) => state.deleteOperator);
  const addBusySlot = useOperatorStore((state) => state.addBusySlot);
  const removeBusySlot = useOperatorStore((state) => state.removeBusySlot);
  const syncAssignments = useOperatorStore((state) => state.syncAssignments);
  const pairwiseConflicts = useOperatorStore((state) => state.pairwiseConflicts);
  const selfConflicts = useOperatorStore((state) => state.selfConflicts);
  const updateRehearsalHours = useOperatorStore((state) => state.updateRehearsalHours);

  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [operatorModalOpen, setOperatorModalOpen] = useState(false);
  const [slotTarget, setSlotTarget] = useState<OperatorRow | null>(null);
  const [leftOperatorId, setLeftOperatorId] = useState<string | null>(null);
  const [rightOperatorId, setRightOperatorId] = useState<string | null>(null);
  const [conflictChecked, setConflictChecked] = useState(true);

  const reload = useCallback(async () => {
    await loadOperators();
    const roleRows = await listAllRoles();
    setRoles(roleRows);
    await syncAssignments(roleRows);
  }, [loadOperators, syncAssignments]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  useEffect(() => {
    if (operators.length === 0) {
      setLeftOperatorId(null);
      setRightOperatorId(null);
      return;
    }
    setLeftOperatorId((prev) => (prev && operators.some((item) => item.id === prev) ? prev : operators[0].id));
    setRightOperatorId((prev) =>
      prev && operators.some((item) => item.id === prev) ? prev : operators.length > 1 ? operators[1].id : null,
    );
  }, [operators]);

  const sortedOperators = useMemo(
    () =>
      [...operators].sort((a, b) => {
        const conflictA = selfConflicts(a.id).length;
        const conflictB = selfConflicts(b.id).length;
        if (conflictA !== conflictB) return conflictB - conflictA;
        return b.assignedRoleIds.length - a.assignedRoleIds.length;
      }),
    [operators, selfConflicts],
  );

  const rolesOf = useCallback(
    (operator: OperatorRow): RoleRow[] => roles.filter((role) => operator.assignedRoleIds.includes(role.id)),
    [roles],
  );

  /** 操耍人档里的指派选择器：按当前操耍人已派角色评估冲突（用于「换绑」演示） */
  const pickerOptionsFor = useCallback(
    (operator: OperatorRow): AssigneeOption[] =>
      operators.map((candidate) => ({
        operator: candidate,
        assessment: {
          operatorId: candidate.id,
          selfConflict: selfConflicts(candidate.id).length > 0,
          selfConflictText: selfConflicts(candidate.id)
            .map(([left, right]) => `${left.label} × ${right.label}`)
            .join('；'),
          crossConflicts: [],
          assignable: candidate.id === operator.id || selfConflicts(candidate.id).length === 0,
          blockReason:
            candidate.id === operator.id
              ? ''
              : selfConflicts(candidate.id).length > 0
                ? `${candidate.name} 自身档期重叠，需先错开时段`
                : '',
        },
        assignedCount: candidate.assignedRoleIds.length,
      })),
    [operators, selfConflicts],
  );

  const totalHours = operators.reduce((acc, operator) => acc + operator.rehearsalHours, 0);
  const conflictPeople = operators.filter((operator) => selfConflicts(operator.id).length > 0).length;
  const unassignedRoles = roles.filter((role) => role.operatorId === null).length;
  const maxHours = Math.max(1, ...operators.map((operator) => operator.rehearsalHours));

  const pairConflicts = useMemo(() => {
    if (!leftOperatorId || !rightOperatorId || leftOperatorId === rightOperatorId) return [];
    return pairwiseConflicts(leftOperatorId, rightOperatorId);
  }, [leftOperatorId, rightOperatorId, pairwiseConflicts]);

  const handleCreateOperator = async () => {
    const values = await operatorForm.validateFields();
    const created = await createOperator(values);
    setOperatorModalOpen(false);
    operatorForm.resetFields();
    message.success(`已登记操耍人「${created.name}」`);
  };

  const handleAddSlot = async () => {
    if (!slotTarget) return;
    const values = await slotForm.validateFields();
    const startMinute = values.start.hour() * 60 + values.start.minute() - DAY_BASE_HOUR * 60;
    if (startMinute < 0) {
      message.warning('排练时段请安排在 08:00 之后');
      return;
    }
    await addBusySlot(slotTarget.id, {
      weekday: values.weekday,
      startMinute,
      durationMinute: values.durationMinute,
      label: values.label.trim() || '排练',
    });
    setSlotTarget(null);
    slotForm.resetFields();
    message.success('时段已登记，冲突视图同步更新');
  };

  const handleDeleteOperator = (operator: OperatorRow) => {
    modal.confirm({
      title: `删除操耍人「${operator.name}」？`,
      content: `其名下 ${operator.assignedRoleIds.length} 个影人角色会被解绑为待指派。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteOperator(operator.id);
        await reload();
        message.success('操耍人已删除，相关角色已解绑');
      },
    });
  };

  /** 某个操耍人的时段表列定义（删除时直接定位到该操耍人）
   *  列宽与容器宽度对齐，配合 tableLayout="fixed" 避免出现「逐字竖排」的塌陷列 */
  const buildSlotColumns = (operator: OperatorRow): ColumnsType<BusySlot> => [
    {
      title: '排练日',
      dataIndex: 'weekday',
      width: 64,
      render: (value: Weekday) => <Tag>{WEEKDAY_LABEL[value]}</Tag>,
    },
    {
      title: '时段',
      key: 'range',
      width: 116,
      render: (_value, record) => (
        <span className="gb-mono">
          {minuteToClock(record.startMinute)} - {minuteToClock(record.startMinute + record.durationMinute)}
        </span>
      ),
    },
    {
      title: '时长',
      dataIndex: 'durationMinute',
      width: 88,
      render: (value: number) => minutesToReadable(value),
    },
    { title: '备注', dataIndex: 'label', ellipsis: true },
    {
      title: '操作',
      key: 'action',
      width: 56,
      render: (_value, record) => (
        <Tooltip title="删除该时段">
          <Button
            size="small"
            danger
            icon={<MinusCircleOutlined />}
            onClick={async () => {
              await removeBusySlot(operator.id, record.id);
              message.success('时段已删除');
            }}
          />
        </Tooltip>
      ),
    },
  ];

  /** 已派角色表：固定列宽 + 弹性「出场提示」列，保证表头与正文都不再逐字换行 */
  const roleColumns: ColumnsType<RoleRow> = [
    { title: '影人角色', dataIndex: 'name', width: 124 },
    {
      title: '行当',
      dataIndex: 'roleType',
      width: 64,
      render: (value: RoleRow['roleType']) => <Tag color={ROLE_TYPE_COLOR[value]}>{ROLE_TYPE_LABEL[value]}</Tag>,
    },
    {
      title: '影件',
      dataIndex: 'propParts',
      width: 118,
      render: (value: RoleRow['propParts']) =>
        value.length > 0 ? value.map((part) => PROP_PART_LABEL[part]).join('／') : '无需拆件',
    },
    { title: '出场提示', dataIndex: 'entranceCue', ellipsis: true },
    {
      title: '操作',
      key: 'action',
      width: 112,
      render: (_value, record) => (
        <Button size="small" onClick={() => navigate(ROUTES.roles(record.sceneId))}>
          去角色页调整
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              操耍人档
            </Typography.Title>
            <Typography.Text type="secondary">
              登记签子操耍人、维护冲突时段，并核对每人已派角色与累计排练时长
            </Typography.Text>
          </div>
          <Space wrap>
            <Button
              type="primary"
              icon={<UserAddOutlined />}
              onClick={() => {
                operatorForm.setFieldsValue({ name: '', skillTags: ['qianzi'] as SkillTag[] });
                setOperatorModalOpen(true);
              }}
            >
              新增操耍人
            </Button>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                const filename = exportOperatorCsvFile(operators, roles);
                message.success(`已导出操耍人档：${filename}`);
              }}
            >
              导出操耍人档
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
              同步指派关系
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="操耍人" value={operators.length} prefix={<TeamOutlined />} suffix="人" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="累计排练" value={totalHours} suffix="小时" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="时段冲突人数" value={conflictPeople} prefix={<AlertOutlined />} suffix="人" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="待指派影人" value={unassignedRoles} suffix="个" />
          </Col>
        </Row>

        <Alert
          style={{ marginTop: 14 }}
          type={conflictPeople > 0 ? 'warning' : 'success'}
          showIcon
          message={
            conflictPeople > 0
              ? `${conflictPeople} 位操耍人的自排时段互相重叠，指派时会被拦截`
              : '全部操耍人档期清晰，无自重叠时段'
          }
          description={
            conflictPeople > 0 ? (
              <Space direction="vertical" size={2}>
                {operators
                  .filter((operator) => selfConflicts(operator.id).length > 0)
                  .map((operator) => (
                    <Typography.Text key={operator.id} type="warning" style={{ fontSize: 12 }}>
                      {operator.name}：
                      {selfConflicts(operator.id)
                        .map(([left, right]) => `${left.label} × ${right.label}`)
                        .join('；')}
                    </Typography.Text>
                  ))}
              </Space>
            ) : (
              '可在时段表中继续登记排练安排，角色指派页会自动拦截冲突。'
            )
          }
        />
      </div>

      {operators.length === 0 ? (
        <div className="gb-panel">
          <EmptyState
            title="操耍人档为空"
            description="先登记班社里的签子师傅，再到角色指派页把影人角色派下去。"
            actionText="新增操耍人"
            onAction={() => setOperatorModalOpen(true)}
          />
        </div>
      ) : (
        <Row gutter={16}>
          <Col xs={24} xl={14}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {sortedOperators.map((operator) => {
                const boundRoles = rolesOf(operator);
                const selfPairs = selfConflicts(operator.id);
                return (
                  <Card
                    key={operator.id}
                    title={
                      <Space size={8} wrap>
                        <Typography.Text strong>{operator.name}</Typography.Text>
                        {operator.skillTags.length === 0 ? (
                          <Tag>未标注技能</Tag>
                        ) : (
                          operator.skillTags.map((tag) => (
                            <Tag key={tag} color={SKILL_TAG_COLOR[tag]}>
                              {SKILL_TAG_LABEL[tag]}
                            </Tag>
                          ))
                        )}
                        <Tag color={boundRoles.length > 0 ? '#7a1f1f' : 'default'}>已派 {boundRoles.length} 个角色</Tag>
                        {selfPairs.length > 0 ? (
                          <Tag color="red" icon={<AlertOutlined />}>
                            档期自冲突 {selfPairs.length} 处
                          </Tag>
                        ) : (
                          <Tag color="green">档期清晰</Tag>
                        )}
                      </Space>
                    }
                    extra={
                      <Space size={4}>
                        <Button
                          size="small"
                          icon={<ClockCircleOutlined />}
                          onClick={() => {
                            slotForm.setFieldsValue({
                              weekday: 1,
                              start: dayjs().hour(DAY_BASE_HOUR).minute(0),
                              durationMinute: 120,
                              label: '连排',
                            });
                            setSlotTarget(operator);
                          }}
                        >
                          登记时段
                        </Button>
                        <Button size="small" icon={<PlusOutlined />} onClick={() => void updateRehearsalHours(operator.id, 1)}>
                          记 +1 小时
                        </Button>
                        <Button
                          size="small"
                          icon={<MinusCircleOutlined />}
                          onClick={() => void updateRehearsalHours(operator.id, -1)}
                        >
                          记 -1 小时
                        </Button>
                        <Button size="small" danger onClick={() => handleDeleteOperator(operator)}>
                          删除
                        </Button>
                      </Space>
                    }
                  >
                    <Row gutter={16} align="middle">
                      <Col xs={24} md={8}>
                        <Space direction="vertical" align="center" style={{ width: '100%' }}>
                          <ProgressRing
                            percent={Math.round((operator.rehearsalHours / maxHours) * 100)}
                            title={`${operator.rehearsalHours} 小时`}
                            center={operator.rehearsalHours}
                            tooltip={`排练投入相对全档最高（${maxHours} 小时）的占比；数值为累计小时`}
                          />
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            累计排练投入
                          </Typography.Text>
                        </Space>
                      </Col>
                      <Col xs={24} md={16}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          指派预览（换绑会同步修改角色页的操耍人）：
                        </Typography.Text>
                        <div style={{ marginTop: 6 }}>
                          <AssigneePicker
                            value={operator.id}
                            options={pickerOptionsFor(operator)}
                            compact
                            showConflictAlert={false}
                            allowClear={false}
                            placeholder="选择要换绑的操耍人"
                            onBlocked={(reason) => message.warning(reason)}
                            onChange={async (nextId) => {
                              if (boundRoles.length === 0 || nextId === operator.id) {
                                message.info('该操耍人暂无已派角色，请到角色指派页分配');
                                return;
                              }
                              const next = operators.find((item) => item.id === nextId);
                              const roleId = boundRoles[0].id;
                              const role = roles.find((item) => item.id === roleId);
                              if (!next || !role) return;
                              const updatedRole: RoleRow = { ...role, operatorId: nextId, updatedAt: nowIso(), revision: ROW_REVISION };
                              const { db } = await import('../utils/db');
                              await db.roles.put(updatedRole);
                              await putOperator({
                                ...operator,
                                assignedRoleIds: operator.assignedRoleIds.filter((id) => id !== roleId),
                                updatedAt: nowIso(),
                                revision: ROW_REVISION,
                              });
                              await putOperator({
                                ...next,
                                assignedRoleIds: [...new Set([...next.assignedRoleIds, roleId])],
                                updatedAt: nowIso(),
                                revision: ROW_REVISION,
                              });
                              await reload();
                              message.success(`「${role.name}」已换绑给 ${next.name}`);
                            }}
                          />
                        </div>
                      </Col>
                    </Row>

                    <div style={{ marginTop: 12 }}>
                      <Typography.Text strong>已排时段（冲突判定依据）</Typography.Text>
                      <Table<BusySlot>
                        rowKey="id"
                        size="small"
                        className="gb-table-compact"
                        style={{ marginTop: 6 }}
                        tableLayout="fixed"
                        columns={buildSlotColumns(operator)}
                        dataSource={operator.busySlots}
                        pagination={false}
                        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已排时段" /> }}
                      />
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <Typography.Text strong>已派影人角色</Typography.Text>
                      <Table<RoleRow>
                        rowKey="id"
                        size="small"
                        className="gb-table-compact"
                        style={{ marginTop: 6 }}
                        tableLayout="fixed"
                        columns={roleColumns}
                        dataSource={boundRoles}
                        pagination={false}
                        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未指派角色" /> }}
                      />
                    </div>
                  </Card>
                );
              })}
            </Space>
          </Col>

          <Col xs={24} xl={10}>
            <div className="gb-panel">
              <div className="gb-panel-title">
                <Typography.Text strong>时段冲突对比</Typography.Text>
                <Space size={6}>
                  <Checkbox checked={conflictChecked} onChange={(event) => setConflictChecked(event.target.checked)}>
                    显示已排时段
                  </Checkbox>
                </Space>
              </div>

              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Space wrap>
                  <Select
                    style={{ width: 160 }}
                    placeholder="操耍人 A"
                    value={leftOperatorId}
                    options={operators.map((operator) => ({ value: operator.id, label: operator.name }))}
                    onChange={setLeftOperatorId}
                  />
                  <Typography.Text>对比</Typography.Text>
                  <Select
                    style={{ width: 160 }}
                    placeholder="操耍人 B"
                    value={rightOperatorId}
                    options={operators.map((operator) => ({ value: operator.id, label: operator.name }))}
                    onChange={setRightOperatorId}
                  />
                </Space>

                {leftOperatorId && rightOperatorId && leftOperatorId === rightOperatorId ? (
                  <Alert type="info" showIcon message="两边选的是同一位操耍人，请换一位再对比" />
                ) : pairConflicts.length === 0 ? (
                  <Alert
                    type="success"
                    showIcon
                    message="两人已排时段无重叠，可同时上场"
                    description="如需安排合排，可直接在角色指派页把同一场次的两个角色分别派给这二人。"
                  />
                ) : (
                  <Alert
                    type="error"
                    showIcon
                    message={`两人有 ${pairConflicts.length} 处时段重叠，不建议同场指派`}
                    description={
                      <Space direction="vertical" size={2}>
                        {pairConflicts.map(([left, right]) => {
                          const from = minuteToClock(Math.max(left.startMinute, right.startMinute));
                          const to = minuteToClock(Math.min(left.endMinute, right.endMinute));
                          return (
                            <Typography.Text
                              key={`${left.slotId}-${right.slotId}`}
                              type="danger"
                              style={{ fontSize: 12 }}
                            >
                              {WEEKDAY_LABEL[left.weekday]} {from}-{to}：{left.label} × {right.label}
                            </Typography.Text>
                          );
                        })}
                      </Space>
                    }
                  />
                )}

                {conflictChecked ? (
                  <Table<{ key: string; name: string; weekday: Weekday; range: string; label: string }>
                    rowKey="key"
                    size="small"
                    className="gb-table-compact"
                    pagination={false}
                    tableLayout="fixed"
                    dataSource={operators
                      .filter((operator) => operator.id === leftOperatorId || operator.id === rightOperatorId)
                      .flatMap((operator) =>
                        operator.busySlots.map((slot) => ({
                          key: `${operator.id}-${slot.id}`,
                          name: operator.name,
                          weekday: slot.weekday,
                          range: `${minuteToClock(slot.startMinute)}-${minuteToClock(slot.startMinute + slot.durationMinute)}`,
                          label: slot.label,
                        })),
                      )}
                    columns={[
                      { title: '操耍人', dataIndex: 'name', width: 96 },
                      { title: '排练日', dataIndex: 'weekday', width: 62, render: (value: Weekday) => WEEKDAY_LABEL[value] },
                      { title: '时段', dataIndex: 'range', width: 104 },
                      { title: '备注', dataIndex: 'label', ellipsis: true },
                    ]}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="两人暂无已排时段" /> }}
                  />
                ) : null}

                <Alert
                  type="info"
                  showIcon
                  message="排期提示"
                  description={
                    <Space direction="vertical" size={2}>
                      <Typography.Text style={{ fontSize: 12 }}>
                        操耍人档共 {operators.length} 人、{operators.reduce((acc, item) => acc + item.busySlots.length, 0)} 段已排时段；
                        影人角色共 {roles.length} 个，待指派 {unassignedRoles} 个。
                      </Typography.Text>
                      <Typography.Text style={{ fontSize: 12 }}>
                        环形指示按全档最高排练小时折算，色块越满表示排练投入越高。
                      </Typography.Text>
                    </Space>
                  }
                />
              </Space>
            </div>
          </Col>
        </Row>
      )}

      <Modal
        open={operatorModalOpen}
        title="新增操耍人"
        okText="登记"
        cancelText="取消"
        onCancel={() => {
          setOperatorModalOpen(false);
          operatorForm.resetFields();
        }}
        onOk={() => void handleCreateOperator()}
      >
        <Form form={operatorForm} layout="vertical" initialValues={{ name: '', skillTags: ['qianzi'] as SkillTag[] }}>
          <Form.Item
            name="name"
            label="姓名 / 艺名"
            rules={[{ required: true, message: '请填写姓名' }, { max: 20, message: '不超过 20 个字' }]}
          >
            <Input placeholder="如：霍连生" />
          </Form.Item>
          <Form.Item
            name="skillTags"
            label="技能标签"
            rules={[{ required: true, message: '至少选择一个技能标签' }]}
          >
            <Checkbox.Group options={[...SKILL_TAG_OPTIONS]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={slotTarget !== null}
        title={slotTarget ? `为 ${slotTarget.name} 登记冲突时段` : '登记冲突时段'}
        okText="登记"
        cancelText="取消"
        onCancel={() => {
          setSlotTarget(null);
          slotForm.resetFields();
        }}
        onOk={() => void handleAddSlot()}
      >
        <Form form={slotForm} layout="vertical">
          <Form.Item name="weekday" label="排练日" rules={[{ required: true, message: '请选择排练日' }]}>
            <Select options={[...WEEKDAY_OPTIONS]} />
          </Form.Item>
          <Form.Item name="start" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
            <TimePicker format="HH:mm" minuteStep={15} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="durationMinute"
            label="持续分钟"
            rules={[{ required: true, message: '请填写持续分钟' }]}
          >
            <Select
              options={[60, 90, 120, 150, 180, 240, 300, 360].map((value) => ({
                value,
                label: `${value} 分钟`,
              }))}
            />
          </Form.Item>
          <Form.Item name="label" label="备注" rules={[{ max: 40, message: '不超过 40 个字' }]}>
            <Input placeholder="如：周一上午·连排《借伞》" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            时段按当日 08:00 起算，可选节点：{SLOT_HINTS.join(' / ')}。
          </Typography.Text>
        </Form>
      </Modal>
    </Space>
  );
}
