import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Layout, Menu, Space, Tag, Typography, message } from 'antd';
import {
  AppstoreOutlined,
  DashboardOutlined,
  ReadOutlined,
  SoundOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { ROUTES } from './router';
import { usePlayStore } from './stores/playStore';
import { useOperatorStore } from './stores/operatorStore';
import { initDatabase } from './utils/db';

const { Header, Sider, Content, Footer } = Layout;

/** 侧边导航：按当前路径高亮，场次/角色/锣鼓点页复用当前剧目上下文 */
function buildSelectedKey(pathname: string, currentPlayId: string | null): string {
  if (pathname.startsWith('/operators')) return ROUTES.operators;
  if (pathname.startsWith('/plays/') && currentPlayId) return ROUTES.scenes(currentPlayId);
  return ROUTES.plays;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPlayId = usePlayStore((state) => state.currentPlayId);
  const plays = usePlayStore((state) => state.plays);
  const counts = usePlayStore((state) => state.counts);
  const loadPlays = usePlayStore((state) => state.loadPlays);
  const loadOperators = useOperatorStore((state) => state.loadOperators);
  const operators = useOperatorStore((state) => state.operators);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDatabase();
        if (cancelled) return;
        await Promise.all([loadPlays(), loadOperators()]);
      } catch (error) {
        if (cancelled) return;
        messageApi.error(`本地数据库初始化失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPlays, loadOperators, messageApi]);

  const currentPlay = plays.find((play) => play.id === currentPlayId) ?? null;
  const selectedKey = buildSelectedKey(location.pathname, currentPlayId);

  return (
    <>
      {contextHolder}
      <Layout style={{ minHeight: '100vh', background: '#f6f1e7' }}>
        <Sider
          width={232}
          breakpoint="lg"
          collapsedWidth={0}
          style={{ background: '#2b1a12', borderRight: '3px solid #7a1f1f' }}
        >
          <div style={{ padding: '18px 16px 10px' }}>
            <Typography.Title level={5} style={{ color: '#f2dfb8', margin: 0 }}>
              皮影戏排演编排台
            </Typography.Title>
            <Typography.Text style={{ color: 'rgba(242,223,184,0.62)', fontSize: 12 }}>
              gbshadowplay · 班社排练统筹
            </Typography.Text>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            style={{ background: 'transparent' }}
            onClick={({ key }) => navigate(key)}
            items={[
              { key: ROUTES.plays, icon: <AppstoreOutlined />, label: '剧目库' },
              {
                key: currentPlayId ? ROUTES.scenes(currentPlayId) : 'scenes-disabled',
                icon: <ReadOutlined />,
                label: currentPlay ? `场次拆分 · ${currentPlay.title}` : '场次拆分（先选剧目）',
                disabled: !currentPlayId,
              },
              { key: ROUTES.operators, icon: <TeamOutlined />, label: '操耍人档' },
            ]}
          />
          <div style={{ padding: '12px 16px', color: 'rgba(242,223,184,0.6)', fontSize: 12 }}>
            <Space direction="vertical" size={2}>
              <span>
                <DashboardOutlined /> 剧目 {counts.plays ?? 0} · 场次 {counts.scenes ?? 0}
              </span>
              <span>
                <TeamOutlined /> 影人 {counts.roles ?? 0} · 操耍人 {operators.length}
              </span>
              <span>
                <SoundOutlined /> 锣鼓点 {counts.cues ?? 0}
              </span>
            </Space>
          </div>
        </Sider>

        <Layout style={{ background: '#f6f1e7' }}>
          <Header
            style={{
              background: '#fffdf8',
              borderBottom: '1px solid rgba(122,31,31,0.16)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingInline: 20,
            }}
          >
            <Space size={10} wrap>
              <Typography.Text strong>当前剧目：</Typography.Text>
              {currentPlay ? (
                <>
                  <Tag color="#7a1f1f">{currentPlay.title}</Tag>
                  <Tag>共 {currentPlay.totalScenes} 场</Tag>
                  <Tag color="gold">进度 {currentPlay.status === 'ready' ? '可上演' : currentPlay.status === 'rehearsing' ? '排练中' : '筹备中'}</Tag>
                </>
              ) : (
                <Tag>未选择剧目</Tag>
              )}
            </Space>
            <Space>
              {currentPlayId ? (
                <Button size="small" onClick={() => navigate(ROUTES.scenes(currentPlayId))}>
                  进入场次
                </Button>
              ) : null}
              <Button size="small" type="primary" onClick={() => navigate(ROUTES.plays)}>
                剧目库
              </Button>
              <Badge count={counts.scenes ?? 0} showZero color="#c9963c" title="场次总数" />
            </Space>
          </Header>

          <Content style={{ padding: 20, minHeight: 320 }}>
            <Outlet />
          </Content>

          <Footer style={{ textAlign: 'center', background: 'transparent', color: 'rgba(0,0,0,0.45)' }}>
            数据仅保存在本机浏览器（IndexedDB / localStorage）·
            <Link to={ROUTES.plays} style={{ marginLeft: 6 }}>
              返回剧目库
            </Link>
          </Footer>
        </Layout>
      </Layout>
    </>
  );
}
