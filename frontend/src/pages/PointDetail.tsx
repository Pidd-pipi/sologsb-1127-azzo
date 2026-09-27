import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, SaveOutlined, ReloadOutlined, MergeCellsOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MapPanel from '../components/common/MapPanel';
import MeasureInput from '../components/common/MeasureInput';
import StatusBadge from '../components/common/StatusBadge';
import FacilityIcon from '../components/common/FacilityIcon';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import { OCCUPIED_LEVELS, type Inspection, type OccupiedLevel } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import { judgeInspection } from '../utils/routeCheck';
import { addDays, isOverdue, todayStr } from '../utils/format';

interface InlineInspection {
  date: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  problem: string;
}

export default function PointDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const points = usePointStore((s) => s.points);
  const allPoints = usePointStore((s) => s.allPoints);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const loaded = usePointStore((s) => s.loaded);
  const addInspection = usePointStore((s) => s.addInspection);
  const addRectify = usePointStore((s) => s.addRectify);
  const mergePoint = usePointStore((s) => s.mergePoint);
  const resolvePoint = usePointStore((s) => s.resolvePoint);
  const handlePointMerged = useRouteStore((s) => s.handlePointMerged);

  const rawPoint = useMemo(() => allPoints.find((p) => p.id === id), [allPoints, id]);
  const canonical = useMemo(() => resolvePoint(id), [resolvePoint, id, allPoints]);
  const point = canonical?.mergedInto ? undefined : canonical;
  const history = useMemo(
    () =>
      inspections
        .filter((i) => i.pointId === (point?.id ?? id))
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    [inspections, point, id],
  );
  const plans = useMemo(
    () =>
      rectifies
        .filter((r) => r.pointId === (point?.id ?? id))
        .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    [rectifies, point, id],
  );

  // 已并出的旧链接（含多级合并）落到保留点位，旧编号继续可查
  useEffect(() => {
    if (loaded && rawPoint?.mergedInto && canonical && canonical.id !== id) {
      navigate(`/points/${canonical.id}`, { replace: true });
    }
  }, [loaded, rawPoint, canonical, id, navigate]);

  const [form, setForm] = useState<InlineInspection>(() => ({
    date: todayStr(),
    inspector: '督导员 李维',
    slope: 2.5,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  }));
  const [saving, setSaving] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | undefined>();
  const [merging, setMerging] = useState(false);

  const mergeCandidates = useMemo(
    () => (point ? points.filter((p) => p.id !== point.id) : []),
    [point, points],
  );

  const judgement = useMemo(
    () =>
      judgeInspection({
        slope: form.slope,
        clearWidth: form.clearWidth,
        hasHandrail: form.hasHandrail,
        tactileContinuous: form.tactileContinuous,
        occupied: form.occupied,
      }),
    [form],
  );

  if (!loaded) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary">正在读取本地点位数据…</Typography.Text>
        </div>
      </div>
    );
  }

  if (!point) {
    if (rawPoint?.mergedInto && canonical && canonical.id !== id) {
      return (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin size="large" />
          <div style={{ marginTop: 12 }}>
            <Typography.Text type="secondary">正在跳转到保留点位…</Typography.Text>
          </div>
        </div>
      );
    }
    return (
      <EmptyState
        title={`未找到点位 ${id}`}
        description="该点位可能已被删除或并入其他点位，请返回总览重新选择"
        extra={
          <Link to="/">
            <Button type="primary">返回核验总览</Button>
          </Link>
        }
      />
    );
  }

  const handleSaveInspection = async () => {
    setSaving(true);
    try {
      await addInspection({
        pointId: point.id,
        date: form.date || todayStr(),
        inspector: form.inspector.trim() || '未署名督导员',
        slope: form.slope,
        clearWidth: form.clearWidth,
        hasHandrail: form.hasHandrail,
        tactileContinuous: form.tactileContinuous,
        occupied: form.occupied,
        conclusion: judgement.conclusion,
        problem: form.problem.trim(),
      });
      message.success(`已新增核验记录（${judgement.conclusion}）`);
      setForm((cur) => ({ ...cur, problem: '', date: todayStr() }));
    } catch (e) {
      message.error(`核验记录保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateRectify = async () => {
    try {
      await addRectify({
        pointId: point.id,
        requirement: judgement.conclusion === '合格' ? '保持现状，纳入下一轮复核' : judgement.reasons.join('；'),
        unit: point.maintainUnit,
        deadline: addDays(todayStr(), 30),
        recheckDate: '',
        status: '待整改',
      });
      message.success('已生成整改条目');
    } catch (e) {
      message.error(`整改条目创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const selectedMergeTarget = points.find((p) => p.id === mergeTargetId);

  const handleMergeConfirm = async () => {
    if (!selectedMergeTarget) {
      message.warning('请先选择要并入的保留点位');
      return;
    }
    setMerging(true);
    try {
      const result = await mergePoint(point.id, selectedMergeTarget.id);
      await handlePointMerged(point.id, selectedMergeTarget.id);
      message.success(
        result.alreadyMerged
          ? `该点位此前已并入 ${result.target.code}，未重复执行`
          : `已并入 ${result.target.code}，转移 ${result.movedInspections} 条核验、${result.movedRectifies} 条整改`,
      );
      setMergeOpen(false);
      navigate(`/points/${result.target.id}`, { replace: true });
    } catch (e) {
      message.error(`点位合并失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMerging(false);
    }
  };

  const openMergeModal = () => {
    setMergeTargetId(undefined);
    setMergeOpen(true);
  };

  const inspectionColumns: ColumnsType<Inspection> = [
    { title: '核验日期', dataIndex: 'date', width: 120, sorter: (a, b) => (a.date < b.date ? -1 : 1) },
    { title: '核验人', dataIndex: 'inspector', width: 130 },
    { title: '坡度', dataIndex: 'slope', width: 80, render: (v: number) => `${v}%` },
    { title: '净宽', dataIndex: 'clearWidth', width: 90, render: (v: number) => `${v} cm` },
    { title: '扶手', dataIndex: 'hasHandrail', width: 70, render: (v: boolean) => (v ? '有' : '无') },
    {
      title: '盲道',
      dataIndex: 'tactileContinuous',
      width: 80,
      render: (v: boolean) => (v ? '连续' : '断续'),
    },
    { title: '占用情况', dataIndex: 'occupied', width: 100 },
    {
      title: '结论',
      dataIndex: 'conclusion',
      width: 110,
      render: (v: string) => <StatusBadge value={v} kind="conclusion" />,
    },
    {
      title: '问题描述',
      dataIndex: 'problem',
      ellipsis: true,
      render: (v: string) => v || <Typography.Text type="secondary">无</Typography.Text>,
    },
  ];

  const rectifyColumns: ColumnsType<RectifyPlan> = [
    { title: '整改要求', dataIndex: 'requirement', ellipsis: true },
    { title: '责任单位', dataIndex: 'unit', width: 170 },
    {
      title: '整改期限',
      dataIndex: 'deadline',
      width: 130,
      render: (d: string, row) =>
        isOverdue(d, row.status) ? (
          <Space size={4}>
            {d}
            <Tag color="error">逾期</Tag>
          </Space>
        ) : (
          d
        ),
    },
    {
      title: '复检日期',
      dataIndex: 'recheckDate',
      width: 120,
      render: (v: string) => v || <Typography.Text type="secondary">未复检</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => <StatusBadge value={v} kind="rectify" />,
    },
  ];

  const latest = history[0];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <Space size={10} align="center">
            <FacilityIcon type={point.facilityType} size={26} />
            <h1 className="gb-page-title" data-testid="point-name">
              {point.name}
            </h1>
            <StatusBadge value={latest?.conclusion ?? '未核验'} kind="conclusion" bordered />
          </Space>
          <Typography.Text type="secondary">
            {point.code}
            {point.aliases?.length ? ` · 原编号 ${point.aliases.join('、')}` : ''} · {point.district} ·{' '}
            {point.location || '未填写所在道路或建筑'}
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<MergeCellsOutlined />} onClick={openMergeModal} data-testid="open-merge-point">
            并入另一个点位
          </Button>
          <Link to="/map">
            <Button>在地图中查看</Button>
          </Link>
          <Link to="/points/new">
            <Button type="primary" icon={<PlusOutlined />}>
              登记新点位
            </Button>
          </Link>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <MapPanel points={[point]} selectedId={point.id} height={380} title="点位定位与周边" />
        </Col>
        <Col xs={24} lg={10}>
          <Card title="点位属性" size="small">
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="点位编号">
                <Space size={6} wrap>
                  {point.code}
                  {point.aliases?.length ? (
                    <Typography.Text type="secondary" data-testid="point-aliases">
                      原编号：{point.aliases.join('、')}
                    </Typography.Text>
                  ) : null}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="设施类型">
                <FacilityIcon type={point.facilityType} withLabel />
              </Descriptions.Item>
              <Descriptions.Item label="行政区">{point.district}</Descriptions.Item>
              <Descriptions.Item label="所在道路或建筑">{point.location || '—'}</Descriptions.Item>
              <Descriptions.Item label="建成年代">{point.builtYear} 年</Descriptions.Item>
              <Descriptions.Item label="养护单位">{point.maintainUnit}</Descriptions.Item>
              <Descriptions.Item label="经纬度">
                {point.lng.toFixed(6)}, {point.lat.toFixed(6)}
              </Descriptions.Item>
              <Descriptions.Item label="核验次数">{history.length} 次</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <Card
            title="核验历史"
            size="small"
            extra={
              <Typography.Text type="secondary" className="gb-muted">
                共 {history.length} 条
              </Typography.Text>
            }
          >
            {history.length ? (
              <Table<Inspection>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 5, hideOnSinglePage: true }}
                dataSource={history}
                columns={inspectionColumns}
              />
            ) : (
              <EmptyState title="暂无核验记录" description="在右侧录入实测值即可生成第一条记录" compact />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="就地新增核验" size="small">
            <Form layout="vertical">
              <Row gutter={12}>
                <Col xs={24} md={12}>
                  <MeasureInput
                    label="坡度"
                    value={form.slope}
                    onChange={(v) => setForm((c) => ({ ...c, slope: v }))}
                    unit="%"
                    pass={5}
                    fail={8}
                    direction="max"
                    min={0}
                    max={100}
                    hint="纵坡不应大于 5%，超过 8% 判定不合格"
                  />
                </Col>
                <Col xs={24} md={12}>
                  <MeasureInput
                    label="净宽"
                    value={form.clearWidth}
                    onChange={(v) => setForm((c) => ({ ...c, clearWidth: v }))}
                    unit="cm"
                    pass={120}
                    fail={90}
                    direction="min"
                    min={0}
                    max={500}
                    step={1}
                    hint="净宽不应小于 120cm，小于 90cm 判定不合格"
                  />
                </Col>
                <Col xs={12} md={8}>
                  <Form.Item label="扶手">
                    <Switch
                      checked={form.hasHandrail}
                      onChange={(v) => setForm((c) => ({ ...c, hasHandrail: v }))}
                      checkedChildren="有"
                      unCheckedChildren="无"
                      data-testid="detail-switch-handrail"
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={8}>
                  <Form.Item label="盲道连续">
                    <Switch
                      checked={form.tactileContinuous}
                      onChange={(v) => setForm((c) => ({ ...c, tactileContinuous: v }))}
                      checkedChildren="连续"
                      unCheckedChildren="断续"
                      data-testid="detail-switch-tactile"
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item label="被占用情况">
                    <Select
                      value={form.occupied}
                      onChange={(v) => setForm((c) => ({ ...c, occupied: v }))}
                      options={OCCUPIED_LEVELS.map((o) => ({ value: o, label: o }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="核验人">
                    <Input
                      id="detail-inspector"
                      value={form.inspector}
                      onChange={(e) => setForm((c) => ({ ...c, inspector: e.target.value }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="结论建议">
                    <Space data-testid="detail-suggested-conclusion">
                      <StatusBadge value={judgement.conclusion} kind="conclusion" bordered />
                      <Typography.Text type="secondary" className="gb-muted">
                        {judgement.reasons[0]}
                      </Typography.Text>
                    </Space>
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="问题描述">
                    <Input.TextArea
                      id="detail-problem"
                      rows={2}
                      value={form.problem}
                      onChange={(e) => setForm((c) => ({ ...c, problem: e.target.value }))}
                      placeholder="记录实测中发现的问题"
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={handleSaveInspection}
                  data-testid="save-inspection"
                >
                  保存核验
                </Button>
                <Button icon={<ReloadOutlined />} onClick={handleCreateRectify} data-testid="gen-rectify">
                  生成整改条目
                </Button>
              </Space>
            </Form>
          </Card>
        </Col>
      </Row>

      <Card title="整改跟踪" size="small" style={{ marginTop: 16 }}>
        <Divider style={{ margin: '0 0 12px' }} />
        {plans.length ? (
          <Table<RectifyPlan> rowKey="id" size="small" pagination={false} dataSource={plans} columns={rectifyColumns} />
        ) : (
          <EmptyState
            title="暂无整改条目"
            description="核验结论为不合格时会自动生成整改条目"
            extra={
              <Button onClick={handleCreateRectify} data-testid="empty-gen-rectify">
                手动生成整改条目
              </Button>
            }
            compact
          />
        )}
      </Card>

      <Modal
        title="并入另一个点位"
        open={mergeOpen}
        onCancel={() => {
          if (!merging) setMergeOpen(false);
        }}
        onOk={handleMergeConfirm}
        okText="确认并入"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: !mergeTargetId, loading: merging }}
        cancelButtonProps={{ disabled: merging }}
        maskClosable={!merging}
        destroyOnClose
        data-testid="merge-modal"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text>
            将当前点位 <Typography.Text strong>{point.code} {point.name}</Typography.Text> 并入保留点位。
            核验历史、整改条目与路线端点会一起转移，原编号仍可作为别名查到。
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            showSearch
            allowClear
            placeholder="选择保留点位（可按名称 / 编号 / 原编号搜索）"
            value={mergeTargetId}
            onChange={(v) => setMergeTargetId(v)}
            filterOption={(input, option) =>
              String(option?.searchText ?? '').toLowerCase().includes(input.trim().toLowerCase())
            }
            options={mergeCandidates.map((p) => ({
              value: p.id,
              searchText: `${p.name} ${p.code} ${(p.aliases ?? []).join(' ')} ${p.location} ${p.district}`,
              label: (
                <Space size={6} wrap>
                  <FacilityIcon type={p.facilityType} size={14} />
                  <span>{p.code} {p.name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {p.district}
                    {p.aliases?.length ? ` · 原编号 ${p.aliases.join('、')}` : ''}
                  </Typography.Text>
                </Space>
              ),
            }))}
            data-testid="merge-target-select"
          />
          {selectedMergeTarget && selectedMergeTarget.facilityType !== point.facilityType ? (
            <Alert
              type="warning"
              showIcon
              message={`两个点位的设施类型不同（${point.facilityType} → ${selectedMergeTarget.facilityType}），请确认是同一处设施`}
            />
          ) : null}
          <Alert
            type="warning"
            showIcon
            message="合并后当前点位不再出现在地图与总览中；重复执行不会产生副本。"
          />
        </Space>
      </Modal>
    </div>
  );
}
