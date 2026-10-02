/**
 * <AssigneePicker> 操耍人选择器
 * 展示技能标签与时段冲突标记；被角色指派页、操耍人档消费。
 */
import { Alert, Button, Select, Space, Tag, Typography } from 'antd';
import { CloseOutlined, PlusOutlined, WarningOutlined } from '@ant-design/icons';
import type { OperatorRow } from '../../utils/db';
import { SKILL_TAG_COLOR, SKILL_TAG_LABEL, minuteToClock, WEEKDAY_LABEL } from '../../types/operator';
import type { CandidateAssessment } from '../../hooks/useOperatorConflict';

export interface AssigneeOption {
  operator: OperatorRow;
  /** 由 useOperatorConflict().assess 得出的可指派评估 */
  assessment: CandidateAssessment;
  /** 已派角色数量（档期负载提示） */
  assignedCount: number;
}

export interface AssigneePickerProps {
  /** 当前已指派的操耍人 id */
  value: string | null;
  /** 候选操耍人（含冲突评估） */
  options: AssigneeOption[];
  /** 指派回调；返回 false 表示被冲突拦截 */
  onChange: (operatorId: string) => void;
  /** 解绑回调 */
  onClear?: () => void;
  /** 允许解绑 */
  allowClear?: boolean;
  /** 选择框占位文案 */
  placeholder?: string;
  /** 紧凑展示（仅标签与选择框） */
  compact?: boolean;
  /** 是否在下方展开冲突候选人清单（表格内使用时建议关闭） */
  showConflictAlert?: boolean;
  /** 拦截提示回调（用于页面 message 提示） */
  onBlocked?: (reason: string) => void;
  disabled?: boolean;
}

/** 技能标签组 */
function SkillTags({ operator }: { operator: OperatorRow }) {
  if (operator.skillTags.length === 0) return <Tag>未标注技能</Tag>;
  return (
    <Space size={2} wrap>
      {operator.skillTags.map((tag) => (
        <Tag key={tag} color={SKILL_TAG_COLOR[tag]} style={{ marginInlineEnd: 0 }}>
          {SKILL_TAG_LABEL[tag]}
        </Tag>
      ))}
    </Space>
  );
}

/** 时段摘要 */
function SlotSummary({ operator }: { operator: OperatorRow }) {
  if (operator.busySlots.length === 0) {
    return <Typography.Text type="secondary" style={{ fontSize: 12 }}>暂无已排时段</Typography.Text>;
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {operator.busySlots
        .slice(0, 3)
        .map(
          (slot) =>
            `${WEEKDAY_LABEL[slot.weekday]} ${minuteToClock(slot.startMinute)}-${minuteToClock(
              slot.startMinute + slot.durationMinute,
            )}`,
        )
        .join('／')}
      {operator.busySlots.length > 3 ? ` 等 ${operator.busySlots.length} 段` : ''}
    </Typography.Text>
  );
}

export function AssigneePicker({
  value,
  options,
  onChange,
  onClear,
  allowClear = true,
  placeholder = '选择操耍人',
  compact = false,
  showConflictAlert = true,
  onBlocked,
  disabled = false,
}: AssigneePickerProps) {
  const current = options.find((option) => option.operator.id === value);
  const conflictCount = options.filter((option) => !option.assessment.assignable).length;

  const selectNode = (
    <Select<string>
      value={value ?? undefined}
      placeholder={placeholder}
      style={{ minWidth: compact ? 180 : 240 }}
      disabled={disabled}
      showSearch
      optionFilterProp="label"
      notFoundContent="操耍人档为空，请先到「操耍人档」新增"
      onChange={(next) => {
        const option = options.find((item) => item.operator.id === next);
        if (option && !option.assessment.assignable) {
          onBlocked?.(option.assessment.blockReason);
          return;
        }
        onChange(next);
      }}
      options={options.map((option) => ({
        value: option.operator.id,
        label: `${option.operator.name}${option.assessment.assignable ? '' : '（时段冲突）'}`,
        disabled: !option.assessment.assignable,
      }))}
      optionRender={(option) => {
        const item = options.find((entry) => entry.operator.id === option.value);
        if (!item) return option.label;
        return (
          <Space direction="vertical" size={2} style={{ padding: '2px 0' }}>
            <Space size={6} wrap>
              <Typography.Text strong>{item.operator.name}</Typography.Text>
              <SkillTags operator={item.operator} />
              <Tag color="default">已派 {item.assignedCount} 个角色</Tag>
              {item.assessment.assignable ? (
                <Tag color="green">可指派</Tag>
              ) : (
                <Tag color="red" icon={<WarningOutlined />}>
                  时段冲突
                </Tag>
              )}
            </Space>
            <SlotSummary operator={item.operator} />
            {!item.assessment.assignable ? (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                {item.assessment.blockReason}
              </Typography.Text>
            ) : null}
          </Space>
        );
      }}
    />
  );

  if (compact) {
    return (
      <Space size={4}>
        {selectNode}
        {allowClear && value ? (
          <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClear} title="解绑" />
        ) : null}
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={8} wrap>
        {selectNode}
        {allowClear && value ? (
          <Button icon={<CloseOutlined />} onClick={onClear} disabled={disabled}>
            解绑
          </Button>
        ) : null}
        {value ? (
          <Tag color="gold" icon={<PlusOutlined />}>
            已指派
          </Tag>
        ) : (
          <Tag>待指派</Tag>
        )}
      </Space>

      {current ? (
        <Space direction="vertical" size={2}>
          <Space size={6} wrap>
            <Typography.Text strong>{current.operator.name}</Typography.Text>
            <SkillTags operator={current.operator} />
            <Tag>累计排练 {current.operator.rehearsalHours} 小时</Tag>
            <Tag>已派角色 {current.assignedCount} 个</Tag>
          </Space>
          <SlotSummary operator={current.operator} />
        </Space>
      ) : null}

      {conflictCount > 0 && showConflictAlert ? (
        <Alert
          type="warning"
          showIcon
          message={`${conflictCount} 位操耍人时段冲突，已在下拉中标记并禁止指派`}
          description={
            <Space direction="vertical" size={0}>
              {options
                .filter((option) => !option.assessment.assignable)
                .map((option) => (
                  <Typography.Text key={option.operator.id} style={{ fontSize: 12 }}>
                    {option.operator.name}：{option.assessment.blockReason}
                  </Typography.Text>
                ))}
            </Space>
          }
        />
      ) : null}
    </Space>
  );
}

export default AssigneePicker;
