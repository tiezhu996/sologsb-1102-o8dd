/**
 * <SceneCard> 场次摘要卡
 * 展示场序、时长、影窗规格与排练进度条；被场次页、锣鼓点页消费。
 */
import { Card, Checkbox, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import type { DragEvent, ReactNode } from 'react';
import {
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  SoundOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { SceneRow } from '../../utils/db';
import { SHADOW_SCREEN_LABEL, maturityOf, MATURITY_COLOR, MATURITY_LABEL } from '../../types/scene';
import { minutesToReadable } from '../../utils/timecode';

export interface SceneCardProps {
  scene: SceneRow;
  /** 该场开场时间码（mm:ss），由 useSceneOrder 计算 */
  startTimecode?: string;
  /** 该场结束时间码 */
  endTimecode?: string;
  /** 影人角色数量 */
  roleCount?: number;
  /** 已指派操耍人的角色数 */
  assignedCount?: number;
  /** 锣鼓点数量 */
  cueCount?: number;
  /** 是否处于本次排练勾选状态 */
  selected?: boolean;
  /** 是否显示勾选框 */
  selectable?: boolean;
  /** 拖拽手柄是否可见（拖拽调序） */
  draggable?: boolean;
  /** 正在被拖拽 */
  dragging?: boolean;
  /** 紧凑模式（锣鼓点页左列使用） */
  compact?: boolean;
  /** 点击卡片主体 */
  onOpen?: () => void;
  onToggleSelect?: (checked: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** 拖拽事件透传，由页面处理排序逻辑 */
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLDivElement>) => void;
  /** 额外操作按钮 */
  extraActions?: ReactNode;
}

export function SceneCard({
  scene,
  startTimecode,
  endTimecode,
  roleCount = 0,
  assignedCount = 0,
  cueCount = 0,
  selected = false,
  selectable = false,
  draggable = false,
  dragging = false,
  compact = false,
  onOpen,
  onToggleSelect,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  extraActions,
}: SceneCardProps) {
  const level = maturityOf(scene.progress);
  const unassigned = Math.max(0, roleCount - assignedCount);

  return (
    <Card
      size={compact ? 'small' : 'default'}
      hoverable={Boolean(onOpen)}
      onClick={onOpen}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        marginBottom: 12,
        borderColor: selected ? '#7a1f1f' : undefined,
        borderWidth: selected ? 2 : 1,
        opacity: dragging ? 0.55 : 1,
        background: selected ? '#fff8f6' : undefined,
      }}
      styles={{ body: { padding: compact ? 12 : 16 } }}
    >
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Space align="start" size={10}>
          {draggable ? (
            <span
              draggable
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onClick={(event) => event.stopPropagation()}
              title="按住拖动可调整场序"
              style={{ cursor: 'grab', color: 'rgba(0,0,0,0.45)', paddingTop: 2 }}
            >
              <HolderOutlined />
            </span>
          ) : null}
          {selectable ? (
            <Checkbox
              checked={selected}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onToggleSelect?.(event.target.checked)}
            >
              <span style={{ display: 'none' }} />
            </Checkbox>
          ) : null}
          <div>
            <Space size={6} wrap>
              <Tag color="#7a1f1f">第 {scene.seq} 场</Tag>
              <Typography.Text strong>{scene.title}</Typography.Text>
              <Tag>{SHADOW_SCREEN_LABEL[scene.needsShadowScreen]}</Tag>
              <Tag color="gold">{minutesToReadable(scene.durationMin)}</Tag>
              {startTimecode ? <Tag color="blue">{startTimecode} 起</Tag> : null}
              {endTimecode ? <Tag color="blue">{endTimecode} 收</Tag> : null}
            </Space>
            {scene.stageNote ? (
              <Typography.Paragraph
                type="secondary"
                ellipsis={{ rows: compact ? 1 : 2, tooltip: scene.stageNote }}
                style={{ margin: '6px 0 0', fontSize: 13, maxWidth: 620 }}
              >
                舞台提示：{scene.stageNote}
              </Typography.Paragraph>
            ) : null}
            <Space size={12} wrap style={{ marginTop: 6, fontSize: 12, color: 'rgba(0,0,0,0.55)' }}>
              <span>
                <TeamOutlined /> 影人 {roleCount} 个｜已派 {assignedCount} 个
                {unassigned > 0 ? `｜待派 ${unassigned} 个` : ''}
              </span>
              <span>
                <SoundOutlined /> 锣鼓点 {cueCount} 处
              </span>
            </Space>
          </div>
        </Space>

        <Space direction="vertical" align="end" size={6} onClick={(event) => event.stopPropagation()}>
          <Tooltip title={`排练进度 ${scene.progress}%（${MATURITY_LABEL[level]}）`}>
            <div style={{ width: compact ? 120 : 180 }}>
              <Progress
                percent={scene.progress}
                size="small"
                strokeColor={MATURITY_COLOR[level]}
                trailColor="rgba(122,31,31,0.10)"
              />
            </div>
          </Tooltip>
          <Space size={4}>
            {extraActions}
            {onEdit ? (
              <Tooltip title="编辑场次">
                <Typography.Link onClick={onEdit}>
                  <EditOutlined />
                </Typography.Link>
              </Tooltip>
            ) : null}
            {onDelete ? (
              <Tooltip title="删除场次">
                <Typography.Link type="danger" onClick={onDelete}>
                  <DeleteOutlined />
                </Typography.Link>
              </Tooltip>
            ) : null}
          </Space>
        </Space>
      </Space>
    </Card>
  );
}

export default SceneCard;
