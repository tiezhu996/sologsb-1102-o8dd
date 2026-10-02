/**
 * 路由表：/plays、/plays/:id/scenes、/scenes/:id/roles、/scenes/:id/cues、/operators
 * 页面按路由懒加载，构建时自动分包。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '../App';

const PlayList = lazy(() => import('../pages/PlayList'));
const SceneBoard = lazy(() => import('../pages/SceneBoard'));
const RoleAssign = lazy(() => import('../pages/RoleAssign'));
const CueTimeline = lazy(() => import('../pages/CueTimeline'));
const OperatorList = lazy(() => import('../pages/OperatorList'));

/** 懒加载页面占位 */
function RouteFallback() {
  return <Skeleton active paragraph={{ rows: 6 }} style={{ background: '#fffdf8', padding: 16, borderRadius: 10 }} />;
}

/** 包裹懒加载页面，避免整页被 Suspense 卸载 */
function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const ROUTES = {
  plays: '/plays',
  scenes: (playId: string): string => `/plays/${playId}/scenes`,
  roles: (sceneId: string): string => `/scenes/${sceneId}/roles`,
  cues: (sceneId: string): string => `/scenes/${sceneId}/cues`,
  operators: '/operators',
} as const;

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.plays} replace /> },
      { path: 'plays', element: withSuspense(<PlayList />) },
      { path: 'plays/:id/scenes', element: withSuspense(<SceneBoard />) },
      { path: 'scenes/:id/roles', element: withSuspense(<RoleAssign />) },
      { path: 'scenes/:id/cues', element: withSuspense(<CueTimeline />) },
      { path: 'operators', element: withSuspense(<OperatorList />) },
      { path: '*', element: <Navigate to={ROUTES.plays} replace /> },
    ],
  },
];

export default appRoutes;
