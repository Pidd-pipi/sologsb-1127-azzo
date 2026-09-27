import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import { makeId, toPlain, todayStr } from '../utils/format';

/** 合并执行结果（用于页面提示与测试断言） */
export interface MergePointResult {
  source: AccessPoint;
  target: AccessPoint;
  movedInspections: number;
  movedRectifies: number;
  /** 改写端点 / 删除自环 / 折叠重复段的路段数 */
  movedRoutes: number;
  /** 重复执行同一合并时为 true，不再产生任何写放大 */
  alreadyMerged: boolean;
}

const byCode = (a: AccessPoint, b: AccessPoint) => a.code.localeCompare(b.code);

/** 沿 mergedInto 链找到保留点位（带环保护） */
function canonicalOf(points: AccessPoint[], id: string): AccessPoint | undefined {
  const byId = new Map(points.map((p) => [p.id, p]));
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur?.mergedInto) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    const next = byId.get(cur.mergedInto);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/** 先按 id / 现编号精确匹配，再按原编号（别名）匹配 */
function findByRef(points: AccessPoint[], ref: string): AccessPoint | undefined {
  return (
    points.find((p) => p.id === ref || p.code === ref) ??
    points.find((p) => (p.aliases ?? []).includes(ref))
  );
}

/**
 * 把路段端点从 sourceId 改挂到 targetId：
 * - 合并后首尾同点的自环段直接删除；
 * - 仅折叠「本次改写产生」的同路线同端点重复段（历史遗留重复保持原样）；
 * - 折叠时障碍/台阶/路缘高差取较大值，可通行取交集，避免掩盖问题；
 * - 最后按路线名重排段序，保证顺序连续。
 */
function mergeRouteSegments(
  rows: RouteSegment[],
  sourceId: string,
  targetId: string,
): { routes: RouteSegment[]; changed: number } {
  const remapped = rows.map((seg) => {
    const touched = seg.fromPointId === sourceId || seg.toPointId === sourceId;
    if (!touched) return { seg, touched };
    return {
      seg: {
        ...seg,
        fromPointId: seg.fromPointId === sourceId ? targetId : seg.fromPointId,
        toPointId: seg.toPointId === sourceId ? targetId : seg.toPointId,
      },
      touched,
    };
  });

  let changed = 0;
  // 先找出本次合并触及的「路线+端点」组合：这些组合内的重复段需要折叠，
  // 与合并无关的历史重复段保持原样
  const touchedKeys = new Set<string>();
  for (const { seg, touched } of remapped) {
    if (touched && seg.fromPointId !== seg.toPointId) {
      touchedKeys.add(`${seg.routeName}${seg.fromPointId}${seg.toPointId}`);
    }
  }

  const kept: RouteSegment[] = [];
  const byKey = new Map<string, RouteSegment>();
  for (const { seg, touched } of remapped) {
    if (touched && seg.fromPointId === seg.toPointId) {
      // 合并后首尾同点的自环段直接删除
      changed += 1;
      continue;
    }
    const key = `${seg.routeName}${seg.fromPointId}${seg.toPointId}`;
    if (!touchedKeys.has(key)) {
      kept.push({ ...seg });
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      const copy = { ...seg };
      byKey.set(key, copy);
      kept.push(copy);
      continue;
    }
    // 折叠重复段：保留先出现的记录，属性取保守值
    existing.length = Math.max(existing.length, seg.length);
    existing.obstacleCount = Math.max(existing.obstacleCount, seg.obstacleCount);
    existing.stepCount = Math.max(existing.stepCount, seg.stepCount);
    existing.curbHeight = Math.max(existing.curbHeight, seg.curbHeight);
    existing.wheelchairPassable = existing.wheelchairPassable && seg.wheelchairPassable;
    existing.order = Math.min(existing.order, seg.order);
    existing.createdAt = existing.createdAt <= seg.createdAt ? existing.createdAt : seg.createdAt;
    changed += 1;
  }

  const groups = new Map<string, RouteSegment[]>();
  for (const seg of kept) {
    const list = groups.get(seg.routeName) ?? [];
    list.push(seg);
    groups.set(seg.routeName, list);
  }
  const routes: RouteSegment[] = [];
  groups.forEach((list) => {
    list
      .sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order))
      .forEach((seg, i) => {
        routes.push({ ...seg, order: i + 1 });
      });
  });
  return { routes, changed };
}

interface PointState {
  /** 在册点位（不含已并出的重复记录），地图与总览只消费它 */
  points: AccessPoint[];
  /** 全量点位（含已并出的墓碑记录），用于按原编号解析 */
  allPoints: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  addInspection: (draft: InspectionDraft) => Promise<Inspection>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  getPoint: (id: string) => AccessPoint | undefined;
  /** 按 id / 编号 / 原编号（别名）解析到保留点位 */
  resolvePoint: (ref: string) => AccessPoint | undefined;
  /** 把 sourceRef 并入 targetRef：核验、整改、路线端点一起转移，幂等 */
  mergePoint: (sourceRef: string, targetRef: string) => Promise<MergePointResult>;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
}

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  allPoints: [],
  inspections: [],
  rectifies: [],
  loading: false,
  loaded: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [points, inspections, rectifies] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
      ]);
      const allPoints = points.sort(byCode);
      set({
        allPoints,
        points: allPoints.filter((p) => !p.mergedInto),
        inspections: inspections.sort((a, b) => (a.date < b.date ? 1 : -1)),
        rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  addPoint: async (draft) => {
    const now = new Date().toISOString();
    const point: AccessPoint = toPlain({
      ...draft,
      id: makeId('pt'),
      createdAt: now,
      updatedAt: now,
    });
    await db.points.put(point);
    set((s) => {
      const allPoints = [...s.allPoints, point].sort(byCode);
      return { allPoints, points: allPoints.filter((p) => !p.mergedInto) };
    });
    return point;
  },

  addInspection: async (draft) => {
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      createdAt: new Date().toISOString(),
    });
    await db.inspections.put(inspection);
    set((s) => ({
      inspections: [inspection, ...s.inspections].sort((a, b) => (a.date < b.date ? 1 : -1)),
    }));
    // 结论为不合格时自动生成整改条目，形成闭环
    if (inspection.conclusion === '不合格') {
      const exists = get().rectifies.some(
        (r) => r.pointId === inspection.pointId && r.status !== '已整改',
      );
      if (!exists) {
        await get().addRectify({
          pointId: inspection.pointId,
          requirement: `按 ${inspection.date} 核验结论整改：${inspection.problem || '坡度、净宽或占用问题'}`,
          unit: '待指派责任单位',
          deadline: todayStr(),
          recheckDate: '',
          status: '待整改',
        });
      }
    }
    return inspection;
  },

  addRectify: async (draft) => {
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      createdAt: new Date().toISOString(),
    });
    await db.rectifies.put(plan);
    set((s) => ({
      rectifies: [...s.rectifies, plan].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    }));
    return plan;
  },

  updateRectify: async (id, patch) => {
    const plain = toPlain(patch);
    await db.rectifies.update(id, plain);
    set((s) => ({
      rectifies: s.rectifies.map((r) => (r.id === id ? { ...r, ...plain } : r)),
    }));
  },

  mergePoint: async (sourceRef, targetRef) => {
    const all = get().allPoints;
    // 源点位按原始记录取：已并出的记录重复提交时走幂等分支，而不是解析成保留点位
    const source = findByRef(all, sourceRef);
    const targetRaw = findByRef(all, targetRef);
    const target = targetRaw ? canonicalOf(all, targetRaw.id) : undefined;
    if (!source) throw new Error('未找到要合并的点位');
    if (!target) throw new Error('未找到保留点位');
    if (source.id === target.id) throw new Error('不能把点位并入自身');

    const result = await db.transaction(
      'rw',
      [db.points, db.inspections, db.rectifies, db.routes],
      async (): Promise<MergePointResult> => {
        const sourceRow = await db.points.get(source.id);
        const targetRow = await db.points.get(target.id);
        if (!sourceRow || !targetRow) throw new Error('点位记录不存在，请刷新后重试');
        const now = new Date().toISOString();

        // 幂等：同一合并重复执行直接返回，不再搬移或复制任何数据
        if (sourceRow.mergedInto === targetRow.id) {
          return {
            source: sourceRow,
            target: targetRow,
            movedInspections: 0,
            movedRectifies: 0,
            movedRoutes: 0,
            alreadyMerged: true,
          };
        }
        if (sourceRow.mergedInto) throw new Error('该点位已并入其他点位，请刷新后重试');
        if (targetRow.mergedInto) throw new Error('保留点位本身已被并出，请刷新后重试');

        // 原编号与既有别名都挂到保留点位上，之后可按原编号检索
        const aliases = Array.from(
          new Set(
            [sourceRow.code, ...(sourceRow.aliases ?? []), ...(targetRow.aliases ?? [])].filter(
              (c) => c && c !== targetRow.code,
            ),
          ),
        );
        const nextTarget: AccessPoint = toPlain({ ...targetRow, aliases, updatedAt: now });
        const nextSource: AccessPoint = toPlain({
          ...sourceRow,
          mergedInto: targetRow.id,
          mergedAt: now,
          updatedAt: now,
        });
        await db.points.bulkPut([nextTarget, nextSource]);

        // 核验历史与整改条目整体转移，整改状态原样保留
        const inspections = await db.inspections.where('pointId').equals(sourceRow.id).toArray();
        if (inspections.length) {
          await db.inspections.bulkPut(
            inspections.map((i) => ({ ...i, pointId: targetRow.id })),
          );
        }
        const rectifies = await db.rectifies.where('pointId').equals(sourceRow.id).toArray();
        if (rectifies.length) {
          await db.rectifies.bulkPut(rectifies.map((r) => ({ ...r, pointId: targetRow.id })));
        }

        // 路线端点改挂保留点位，折叠合并产生的自环与重复段
        const routeRows = await db.routes.toArray();
        const merged = mergeRouteSegments(routeRows, sourceRow.id, targetRow.id);
        await db.routes.clear();
        if (merged.routes.length) await db.routes.bulkPut(merged.routes);

        return {
          source: nextSource,
          target: nextTarget,
          movedInspections: inspections.length,
          movedRectifies: rectifies.length,
          movedRoutes: merged.changed,
          alreadyMerged: false,
        };
      },
    );

    set((s) => {
      const allPoints = s.allPoints
        .map((p) => (p.id === result.source.id ? result.source : p.id === result.target.id ? result.target : p))
        .sort(byCode);
      return {
        allPoints,
        points: allPoints.filter((p) => !p.mergedInto),
        inspections: s.inspections.map((i) =>
          i.pointId === result.source.id ? { ...i, pointId: result.target.id } : i,
        ),
        rectifies: s.rectifies.map((r) =>
          r.pointId === result.source.id ? { ...r, pointId: result.target.id } : r,
        ),
      };
    });
    return result;
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  resolvePoint: (ref) => {
    const all = get().allPoints;
    const hit = findByRef(all, ref);
    return hit ? canonicalOf(all, hit.id) : undefined;
  },

  inspectionsOf: (pointId) =>
    get()
      .inspections.filter((i) => i.pointId === pointId)
      .sort((a, b) => (a.date < b.date ? 1 : -1)),

  rectifiesOf: (pointId) =>
    get()
      .rectifies.filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
}));
