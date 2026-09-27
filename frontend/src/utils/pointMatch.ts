import type { AccessPoint } from '../types/point';

/** 点位全文匹配：名称 / 编号 / 原编号（别名）/ 位置 / 行政区 */
export function pointMatchesKeyword(point: AccessPoint, keyword: string): boolean {
  const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    point.name,
    point.code,
    ...(point.aliases ?? []),
    point.location,
    point.district,
  ]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
