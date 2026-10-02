/**
 * <ProgressRing> 排练成熟度环形指示
 * 被剧目库、操耍人档消费，也用于任一场次进度的快速展示。
 */
import { Progress, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import { MATURITY_COLOR, MATURITY_LABEL, maturityOf } from '../../types/scene';

export interface ProgressRingProps {
  /** 0-100 */
  percent: number;
  /** 环直径，默认 84 */
  size?: number;
  /** 环下方标题 */
  title?: ReactNode;
  /** 环中心自定义内容（默认显示百分比） */
  center?: ReactNode;
  /** 是否显示成熟度文案（生台/顺场/待合乐/可上演） */
  showMaturity?: boolean;
  /** 附加提示 */
  tooltip?: string;
}

export function ProgressRing({
  percent,
  size = 84,
  title,
  center,
  showMaturity = true,
  tooltip,
}: ProgressRingProps) {
  const safe = Math.min(100, Math.max(0, Number.isFinite(percent) ? Math.round(percent) : 0));
  const level = maturityOf(safe);
  const color = MATURITY_COLOR[level];

  const ring = (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <Progress
        type="circle"
        percent={safe}
        size={size}
        strokeColor={color}
        trailColor="rgba(122, 31, 31, 0.12)"
        strokeWidth={8}
        format={() => <span style={{ fontSize: size / 4.4, color }}>{center ?? `${safe}%`}</span>}
      />
      {title ? <span style={{ fontSize: 13, color: 'rgba(0,0,0,0.72)' }}>{title}</span> : null}
      {showMaturity ? (
        <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{MATURITY_LABEL[level]}</span>
      ) : null}
    </div>
  );

  return tooltip ? <Tooltip title={tooltip}>{ring}</Tooltip> : ring;
}

export default ProgressRing;
