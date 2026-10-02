/**
 * 合并冲突核对控件
 * 同一字段两边都改 → 两边取值并列保留，选一边后再随整包一起提交。
 */
import { Card, Radio, Space, Tag, Typography } from 'antd';
import { ArrowRightOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import type {
  ArrayConflict,
  ArrayPolicy,
  DeleteModifyConflict,
  DeletePolicy,
  FieldConflict,
  FieldSide,
} from '../types/rehearsalPackage';

interface FieldConflictEditorProps {
  conflict: FieldConflict;
  format: (value: unknown) => string;
  sideLabel: { local: string; remote: string };
  onChange: (resolution: FieldSide) => void;
}

export function FieldConflictEditor({ conflict, format, sideLabel, onChange }: FieldConflictEditorProps) {
  return (
    <div className="gb-conflict-field">
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Typography.Text strong>
          {conflict.fieldLabel}
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            底稿值：{format(conflict.baseValue)}
          </Typography.Text>
        </Typography.Text>
        <Radio.Group
          value={conflict.resolution}
          onChange={(event) => onChange(event.target.value as FieldSide)}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Radio value="local" className={conflict.resolution === 'local' ? 'gb-conflict-picked' : ''}>
              <Space size={6} wrap>
                <Tag color="blue">{sideLabel.local}</Tag>
                <span>{format(conflict.localValue)}</span>
              </Space>
            </Radio>
            <Radio value="remote" className={conflict.resolution === 'remote' ? 'gb-conflict-picked' : ''}>
              <Space size={6} wrap>
                <Tag color="volcano">{sideLabel.remote}</Tag>
                <span>{format(conflict.remoteValue)}</span>
              </Space>
            </Radio>
          </Space>
        </Radio.Group>
      </Space>
    </div>
  );
}

interface ArrayConflictEditorProps {
  conflict: ArrayConflict;
  onChange: (resolution: ArrayPolicy) => void;
}

function changeList(items: Array<{ code: string; label: string }>, text: string, color?: string) {
  if (items.length === 0) return null;
  return (
    <Typography.Text key={text} style={{ fontSize: 12 }} type={color === 'danger' ? 'danger' : 'success'}>
      {text}
      {items.map((item) => item.label).join('、')}
    </Typography.Text>
  );
}

export function ArrayConflictEditor({ conflict, onChange }: ArrayConflictEditorProps) {
  return (
    <div className="gb-conflict-field">
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Typography.Text strong>{conflict.fieldLabel}（两边都有增删）</Typography.Text>
        <Space size={4} wrap style={{ paddingLeft: 24 }}>
          {changeList(conflict.localAdded, '本机新增：')}
          {changeList(conflict.localRemoved, '本机撤掉：', 'danger')}
          {changeList(conflict.remoteAdded, '分队新增：')}
          {changeList(conflict.remoteRemoved, '分队撤掉：', 'danger')}
        </Space>
        <Radio.Group
          value={conflict.resolution ?? 'union'}
          onChange={(event) => onChange(event.target.value as ArrayPolicy)}
        >
          <Radio.Button value="union">并列保留（并集）</Radio.Button>
          <Radio.Button value="local">只用本机</Radio.Button>
          <Radio.Button value="remote">只用分队</Radio.Button>
        </Radio.Group>
      </Space>
    </div>
  );
}

interface DeleteModifyEditorProps {
  conflict: DeleteModifyConflict;
  entityLabel: string;
  onChange: (resolution: DeletePolicy) => void;
}

export function DeleteModifyEditor({ conflict, entityLabel, onChange }: DeleteModifyEditorProps) {
  const deleteSide = conflict.deletedBy === 'local' ? '本机' : '分队';
  const modifySide = conflict.deletedBy === 'local' ? '分队' : '本机';
  return (
    <Card size="small" style={{ background: '#fff7f5', borderColor: '#e2b5ad' }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text strong>
          一边撤掉、另一边改动了「{entityLabel}」
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {deleteSide}已撤掉；{modifySide}的改动：{conflict.modifiedSummary || '有改动'}
        </Typography.Text>
        <Radio.Group
          value={conflict.resolution ?? undefined}
          onChange={(event) => onChange(event.target.value as DeletePolicy)}
        >
          <Radio.Button value="keep">
            <SaveOutlined /> 保留「{entityLabel}」
          </Radio.Button>
          <Radio.Button value="delete">
            <DeleteOutlined /> 按撤掉处理
          </Radio.Button>
        </Radio.Group>
        {conflict.resolution === 'delete' ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            <ArrowRightOutlined /> 提交后删除；相关角色指派与锣鼓点会一并清理 / 解绑
          </Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
}
