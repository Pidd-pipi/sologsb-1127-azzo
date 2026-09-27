import { useEffect, useMemo, useState } from 'react';
import { AutoComplete, Layout, Menu, Space, Tag, Typography } from 'antd';
import {
  HomeOutlined,
  PlusCircleOutlined,
  EnvironmentOutlined,
  NodeIndexOutlined,
  ToolOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';

const { Sider, Content, Header } = Layout;

const MENU = [
  { key: '/', icon: <HomeOutlined />, label: '核验总览' },
  { key: '/points/new', icon: <PlusCircleOutlined />, label: '点位登记' },
  { key: '/routes', icon: <NodeIndexOutlined />, label: '通行路线' },
  { key: '/map', icon: <EnvironmentOutlined />, label: '设施地图' },
  { key: '/rectify', icon: <ToolOutlined />, label: '整改清单' },
];

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const loadPoints = usePointStore((s) => s.load);
  const loadRoutes = useRouteStore((s) => s.load);
  const points = usePointStore((s) => s.points);
  const pointCount = usePointStore((s) => s.points.length);
  const inspectionCount = usePointStore((s) => s.inspections.length);
  const hasKey = Boolean((import.meta.env.VITE_AMAP_KEY || '').trim());
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    void loadPoints();
    void loadRoutes();
  }, [loadPoints, loadRoutes]);

  // 编号 / 名称 / 历史别名（已并入记录的原编号）均可检索
  const options = useMemo(() => {
    const kw = keyword.trim().toUpperCase();
    const list = kw
      ? points.filter(
          (p) =>
            p.code.toUpperCase().includes(kw) ||
            p.name.toUpperCase().includes(kw) ||
            (p.aliases ?? []).some((a) => a.toUpperCase().includes(kw)),
        )
      : points;
    return list.slice(0, 12).map((p) => ({
      value: p.id,
      label: (
        <Space size={6} wrap>
          <Typography.Text strong>{p.name}</Typography.Text>
          <Typography.Text type="secondary">{p.code}</Typography.Text>
          {p.aliases?.length ? (
            <Tag color="default" style={{ marginInlineStart: 0 }}>
              别名 {p.aliases.join('、')}
            </Tag>
          ) : null}
        </Space>
      ),
    }));
  }, [points, keyword]);

  const selectedKey =
    MENU.map((m) => m.key)
      .filter((k) => k !== '/' && location.pathname.startsWith(k))
      .sort((a, b) => b.length - a.length)[0] || '/';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={216} theme="dark" breakpoint="lg" collapsedWidth={64}>
        <div className="gb-logo">
          <DatabaseOutlined style={{ fontSize: 20 }} />
          <div>
            <div className="gb-logo-title">无障碍设施核验</div>
            <div className="gb-logo-sub">gbaccessmap</div>
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU.map((m) => ({
            key: m.key,
            icon: m.icon,
            label: <Link to={m.key}>{m.label}</Link>,
          }))}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            borderBottom: '1px solid #eef1f5',
          }}
        >
          <Typography.Title level={5} style={{ margin: 0, whiteSpace: 'nowrap' }}>
            城市无障碍设施核验地图
          </Typography.Title>
          <Space size={12} style={{ flex: 1, justifyContent: 'flex-end' }}>
            <AutoComplete
              style={{ width: 280 }}
              options={options}
              value={keyword}
              onChange={setKeyword}
              onSelect={(value) => {
                navigate(`/points/${value}`);
                setKeyword('');
              }}
              placeholder="按编号 / 名称 / 历史别名查找点位"
              allowClear
              data-testid="point-lookup"
            />
            <Tag color="blue" data-testid="count-points">
              点位 {pointCount}
            </Tag>
            <Tag color="cyan" data-testid="count-inspections">
              核验 {inspectionCount}
            </Tag>
            <Tag color={hasKey ? 'green' : 'orange'} data-testid="amap-key-tag">
              {hasKey ? '高德地图已配置' : '网格降级模式'}
            </Tag>
          </Space>
        </Header>
        <Content>
          <div className="gb-content">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
