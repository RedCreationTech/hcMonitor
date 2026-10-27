"""Continuous recording segments and explicitly verified file-clock analysis ranges."""
import math


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_capture(capture, assets):
    if capture is not None and not isinstance(capture,dict):raise ValueError('采集记录必须为对象')
    if not capture or capture.get('mode') != 'independent-segments-v1':
        return capture
    parts = capture.get('segments')
    if not isinstance(parts, list) or len(parts) != len(assets):
        raise ValueError('连续片段登记必须与素材逐一对应')
    ids = {a['id'] for a in assets}
    if {p.get('asset_id') for p in parts if isinstance(p, dict)} != ids:
        raise ValueError('连续片段素材编号缺失或重复')
    previous = 0
    for p in parts:
        if not finite(p.get('wall_start')) or not finite(p.get('wall_end')) or not 0 <= previous <= p['wall_start'] < p['wall_end']:
            raise ValueError('连续片段现场时间无效或重叠')
        if p.get('closed_by') not in ('pause', 'stop', 'device-ended', 'recorder-error', 'lease-lost', 'storage-error', 'recovered'):
            raise ValueError('连续片段结束原因无效')
        previous = p['wall_end']
    return capture


def unmapped_gap(session, asset):
    capture = session.get('capture') or {}
    if capture.get('mode') == 'independent-segments-v1':
        validate_capture(capture, session['assets'])
        part = next(p for p in capture['segments'] if p['asset_id'] == asset['id'])
        return part['closed_by'] not in ('pause', 'stop')
    return bool(capture.get('gaps'))


def validate_intervals(ranges, assets):
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 12:
        raise ValueError('请登记1至12个已核验的连续有效区间')
    by_id = {a['id']: a for a in assets}
    previous = {}
    for r in ranges:
        if not isinstance(r, dict) or r.get('asset_id') not in by_id:
            raise ValueError('有效区间素材不存在')
        a = by_id[r['asset_id']]
        if a['kind'] not in ('audio', 'video') or not finite(r.get('start')) or not finite(r.get('end')):
            raise ValueError('有效区间只适用于音视频，边界必须为有限秒数')
        if not 0 <= previous.get(a['id'], 0) <= r['start'] < r['end'] <= a.get('duration_seconds', 0) + 1:
            raise ValueError('有效区间越界、重叠或顺序无效')
        previous[a['id']] = r['end']
    return [{k: r[k] for k in ('asset_id', 'start', 'end')} for r in ranges]
