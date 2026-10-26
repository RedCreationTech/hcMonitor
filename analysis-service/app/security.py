"""Local credentials and resource policy shared by HTTP, events and media."""
import hashlib
import hmac
import secrets
import time
from fastapi import HTTPException

ROLES = {
    'analyst': {'read', 'analyze', 'edit', 'review_request', 'capture'},
    'reviewer': {'read', 'review', 'publish', 'grant'},
    'collector': {'capture'}, 'reader': {'report_read'},
    'admin': {'manage', 'audit'}, 'auditor': {'audit'},
}


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 260000).hex()
    return f'pbkdf2_sha256${salt}${digest}'


def check_password(password, encoded):
    try:
        _, salt, _ = encoded.split('$')
        return hmac.compare_digest(password_hash(password, salt), encoded)
    except ValueError:
        return False


def bootstrap(store, password, project='PRJ-LOCAL'):
    if len(password) < 12: raise ValueError('初始化口令至少12位')
    with store.transaction() as db:
        if db['users']: raise ValueError('账号已初始化，拒绝覆盖')
        for uid, name, role in [('W-02', '分析师', 'analyst'), ('R-01', '复核人', 'reviewer'),
                                ('C-04', '采集员', 'collector'), ('A-01', '项目管理员', 'admin'),
                                ('READ-01', '报告阅读者', 'reader'), ('AUD-01', '审计员', 'auditor')]:
            db['users'].append(dict(id=uid, name=name, role=role, person_id=uid, seat=uid,
                                    password=password_hash(password), projects=[project], enabled=True))
        db['projects'].append(dict(id=project, name='本地访谈项目'))
        store.audit('系统', 'workspace.bootstrap', project)


def authenticate(store, token):
    record = store.db.get('tokens', {}).get(hashlib.sha256((token or '').encode()).hexdigest())
    if not record or record['expires'] <= time.time(): raise HTTPException(401, '登录已失效')
    user = store.get('users', record['user_id'])
    if not user or not user.get('enabled'): raise HTTPException(401, '账号不可用')
    return user


def public_user(user):
    return {k: v for k, v in user.items() if k not in ('password', 'failed', 'locked_until')}


def require(user, capability):
    if capability not in ROLES.get(user['role'], set()): raise HTTPException(403, '当前职责不允许此操作')


def session_access(user, session, purpose='read'):
    if not session or session.get('project_id') not in user.get('projects', []):
        raise HTTPException(404, '资源不存在或不可见')
    if session.get('restricted') or len(session.get('participants', [])) != 2 or not all(p.get('purposes', {}).get('analyze', False) and (not p.get('expires_at') or p['expires_at'] > time.time()) for p in session.get('participants', [])):
        raise HTTPException(403, '会话用途已受限')
    assigned = {session.get('owner_id'), session.get('analyst_id'), session.get('reviewer_id')}
    require(user, 'capture' if purpose == 'capture' else 'read')
    if user['id'] not in assigned: raise HTTPException(403, '未分派此任务')
    if user['role'] == 'reviewer' and not all(p.get('purposes', {}).get('review', False) for p in session.get('participants', [])):
        raise HTTPException(403, '缺少专家查看用途授权')
    if purpose == 'capture' and not all(p.get('purposes', {}).get('capture', False) for p in session['participants']):
        raise HTTPException(403, '采集用途未授权')
    return session
