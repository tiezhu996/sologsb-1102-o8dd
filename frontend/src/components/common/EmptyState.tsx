/**
 * <EmptyState> 空数据引导与新建入口
 * 被全部列表页消费。
 */
import { Button, Empty, Space, Typography } from 'antd';
import type { ReactNode } from 'react';
import { PlusOutlined } from '@ant-design/icons';

export interface EmptyStateProps {
  /** 标题，例如「还没有剧目」 */
  title: string;
  /** 说明文案 */
  description?: ReactNode;
  /** 主操作按钮文案；不传则不渲染按钮 */
  actionText?: string;
  /** 主操作回调 */
  onAction?: () => void;
  /** 次操作按钮文案（如「导入存档」） */
  secondaryText?: string;
  onSecondary?: () => void;
  /** 附加内容（提示、快捷键说明等） */
  extra?: ReactNode;
  /** 空状态图占位高度 */
  size?: 'small' | 'default';
}

export function EmptyState({
  title,
  description,
  actionText,
  onAction,
  secondaryText,
  onSecondary,
  extra,
  size = 'default',
}: EmptyStateProps) {
  return (
    <div
      style={{
        padding: size === 'small' ? '20px 12px' : '48px 24px',
        textAlign: 'center',
        background: '#fffdf8',
        border: '1px dashed rgba(122, 31, 31, 0.28)',
        borderRadius: 10,
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        imageStyle={{ height: size === 'small' ? 40 : 60 }}
        description={
          <Space direction="vertical" size={4}>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {title}
            </Typography.Text>
            {description ? (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {description}
              </Typography.Text>
            ) : null}
          </Space>
        }
      >
        {actionText || secondaryText ? (
          <Space wrap>
            {actionText && onAction ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={onAction}>
                {actionText}
              </Button>
            ) : null}
            {secondaryText && onSecondary ? <Button onClick={onSecondary}>{secondaryText}</Button> : null}
          </Space>
        ) : null}
      </Empty>
      {extra ? <div style={{ marginTop: 12 }}>{extra}</div> : null}
    </div>
  );
}

export default EmptyState;
