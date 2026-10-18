import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import focused_profile
import focused_signal


class Mediation:
    def __init__(self, root, workspace, node, temporary, row_id, template, renderer, renderer_env, prefix, entries=None, helper=None):
        self.entries = entries or {}
        self.helper = helper if helper is not None else root / 'scope'
        self.root = root
        self.workspace = workspace
        self.node = node
        self.temporary = Path(temporary)
        self.row_id = row_id
        self.template = template
        self.renderer = renderer
        self.renderer_env = renderer_env
        self.prefix = prefix
        self.reader = str(workspace / template['readerEntry'])
        self.records = {}
        self.observed = {}
        self.recipient_births = {}
        self.requests = []
        self.cleanup_races = set()
        self.cleanup_races_confirmed = set()
        self.launch_births = {}
        self.buffer = b''
        self.read_fd, self.request_fd = os.pipe()
        self.response_fd, self.write_fd = os.pipe()
        self.lock_read_fd, self.lock_write_fd = os.pipe()
        os.write(self.lock_write_fd, b'1')
        os.set_blocking(self.read_fd, False)

    def environment(self, env):
        return dict(env, SCG_REQUEST_FD=str(self.request_fd), SCG_RESPONSE_FD=str(self.response_fd), SCG_REQUEST_LOCK_READ_FD=str(self.lock_read_fd), SCG_REQUEST_LOCK_WRITE_FD=str(self.lock_write_fd))

    def parent_close(self):
        for name in ('request_fd', 'response_fd', 'lock_read_fd', 'lock_write_fd'):
            descriptor = getattr(self, name)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)

    def close(self):
        self.parent_close()
        for name in ('read_fd', 'write_fd'):
            descriptor = getattr(self, name)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)

    def approve_profile(self, fixture, profile):
        layout = focused_profile.materialize(self.template, self.temporary, fixture, profile)
        key = str(profile)
        if key in self.records:
            raise ValueError('duplicate recipient launch for focused row')
        result = subprocess.run([*self.prefix, self.node, str(self.renderer), str(self.workspace), str(fixture), str(profile), self.node, self.reader], cwd=self.workspace, env=self.renderer_env, capture_output=True, text=True, timeout=2)
        if result.returncode != 0:
            raise ValueError('production profile rendering failed under outer profile')
        rendered = json.loads(result.stdout)
        if set(rendered) != {'policy', 'profile'} or rendered['policy'] != layout['policy'] or not isinstance(rendered['profile'], str):
            raise ValueError('production renderer policy differs from reviewed declaration')
        expected = rendered['profile'].encode()
        state = focused_profile.profile_state(profile, expected)
        owner = hashlib.sha256(b'["owner","bee"]').hexdigest()
        content_root = Path(fixture) / 'data/delivery-content' / owner
        contents = list(content_root.glob('*.txt'))
        if len(contents) != 1 or contents[0].resolve(strict=True) != contents[0] or not contents[0].is_file():
            raise ValueError('exact published delivery-content probe path is missing or redirected')
        self.records[key] = {'layout': layout, 'state': state, 'expected': expected, 'content': str(contents[0]), 'livePolicies': []}
        return state

    def race_counts(self):
        return {'pending': len(self.cleanup_races - self.cleanup_races_confirmed), 'confirmed': len(self.cleanup_races_confirmed), 'total': len(self.cleanup_races)}

    def observe_reader(self, helper, birth, observation, instrumented=True):
        if not observation['sandboxed'] or observation['entry'] != self.reader:
            raise ValueError('reader is not the pinned sandboxed recipient')
        profile = Path(observation['cwd']) / 'sandbox.sb'
        if str(profile) not in self.records:
            self.approve_profile(profile.parent.parent, profile)
        record = self.records[str(profile)]
        if observation['cwd'] != record['layout']['cwd']:
            raise ValueError('reader cwd differs from reviewed policy template')
        identity = tuple(birth)
        try:
            state = focused_profile.profile_state(profile, record['expected'])
        except FileNotFoundError:
            if instrumented or self.observed.get(identity) != str(profile) or not record['livePolicies']:
                raise
            self.cleanup_races.add(identity)
            return record['livePolicies'][-1]['policy']
        if state != record['state']:
            raise ValueError('profile changed at live reader observation')
        sealed = self.workspace.parent
        result = subprocess.run([str(helper), 'write-policy', *birth, observation['cwd'], record['content'], str(sealed)], capture_output=True, text=True, timeout=2)
        if result.returncode != 0:
            raise ValueError('live sandbox write policy query failed exit=' + str(result.returncode) + ': ' + result.stderr.strip())
        policy = focused_profile.parse_write_policy(result.stdout)
        identity = tuple(birth)
        if identity in self.observed and self.observed[identity] != str(profile):
            raise ValueError('recipient changed profile path')
        self.observed[identity] = str(profile)
        self.recipient_births[identity] = list(birth)
        record['livePolicies'].append({'birth': birth, 'policy': policy, 'probePaths': {'cellDir': observation['cwd'], 'deliveryContent': record['content'], 'sealedRoot': str(sealed)}})
        return policy

    def drain(self, retained, signal_handler=None):
        while True:
            try:
                data = os.read(self.read_fd, 65536)
            except BlockingIOError:
                break
            if not data:
                break
            self.buffer += data
            if len(self.buffer) > 4096:
                raise ValueError('recipient mediation request exceeds bound')
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                request = json.loads(line)
                if not isinstance(request, dict) or type(request.get('pid')) is not int or type(request.get('id')) is not int or request['id'] <= 0:
                    raise ValueError('malformed recipient mediation request')
                identities = [row for row in retained.values() if int(row[0]) == request['pid']]
                if len(identities) != 1:
                    raise ValueError('requesting process birth is unobserved or ambiguous')
                status = subprocess.run([str(self.helper), 'status', *identities[0]], capture_output=True, text=True, timeout=2)
                if status.returncode != 0:
                    raise ValueError('requesting process birth could not be verified')
                role = getattr(self, 'roles', None)
                if self.entries and (role is None or role.identities.get(request['pid'], (None,))[0] != tuple(identities[0])):
                    raise ValueError('requesting Node role has not been birth-verified')
                response = {'pid': request['pid'], 'id': request['id'], 'allowed': False}
                try:
                    if request.get('operation') == 'profile':
                        if self.entries and role.identities[request['pid']][1] != 'runner-host-main':
                            raise ValueError('profile requester has wrong parent role')
                        if set(request) != {'operation', 'pid', 'id', 'rowId', 'fixtureRoot', 'profile', 'node', 'entry', 'cwd'} or request['rowId'] != self.row_id or request['node'] != self.node or request['entry'] != self.reader or request['cwd'] != str(Path(request['fixtureRoot']) / 'work'):
                            raise ValueError('profile request differs from reviewed row declaration')
                        self.approve_profile(Path(request['fixtureRoot']), Path(request['profile']))
                    elif request.get('operation') == 'signal' and signal_handler is not None:
                        signal_handler(request, identities[0])
                    else:
                        raise ValueError('unapproved controller mediation operation')
                    response['allowed'] = True
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    response['reason'] = 'controller validation refused'
                    self.requests.append({'failure': str(error)})
                self.requests.append({'request': request, 'response': response})
                encoded = (json.dumps(response, separators=(',', ':')) + '\n').encode()
                if len(encoded) > 4096 or os.write(self.write_fd, encoded) != len(encoded):
                    raise ValueError('incomplete controller mediation response')
                if not response['allowed']:
                    raise ValueError(response['reason'])

    def approved_launches(self, events, retained):
        for event in events:
            if event.get('kind') != 'spawn' or type(event.get('childPid')) is not int or not isinstance(event.get('launchId'), str) or type(event.get('emittedAtMs')) is not int or event['launchId'] in self.launch_births:
                continue
            candidates = [row for row in retained.values() if int(row[0]) == event['childPid'] and int(row[2]) * 1000 + int(row[3]) // 1000 <= event['emittedAtMs']]
            if len(candidates) == 1:
                self.launch_births[event['launchId']] = list(candidates[0])
        return {int(row[0]): row for row in self.launch_births.values()}

    def signal(self, request, requester, retained, approved):
        if set(request) != {'pid', 'id', 'operation', 'target', 'signal'} or type(request['target']) is not int or type(request['signal']) not in (int, str) or request['signal'] not in (0, 'SIGTERM', 'SIGKILL', 15, 9):
            raise ValueError('unapproved signal request')
        current = {}
        for row in retained.values():
            status = subprocess.run([str(self.helper), 'status', *row], capture_output=True, text=True, timeout=2)
            if status.returncode == 0:
                current[int(row[0])] = row
            elif status.returncode != 3:
                raise ValueError('unresolved retained birth during signal verification')
        members = None
        if request['target'] < -1:
            leader = current.get(-request['target'])
            if leader is None:
                raise ValueError('process-group leader unobserved')
            group = subprocess.run([str(self.helper), 'group', *leader], capture_output=True, text=True, timeout=2)
            if group.returncode != 0:
                raise ValueError('process-group membership unobserved')
            rows = [line.split() for line in group.stdout.splitlines()]
            if not rows or any(len(row) != 4 or not all(part.isdigit() for part in row) or current.get(int(row[0])) != row for row in rows):
                raise ValueError('process-group has an unverified or foreign member')
            members = [int(row[0]) for row in rows]
        focused_signal.authorize(int(requester[0]), request['target'], list(retained.values()), approved, current, members)
        number = {'SIGTERM': 15, 'SIGKILL': 9}.get(request['signal'], request['signal'])
        if number:
            leader = current[abs(request['target'])]
            command = [str(self.helper), 'signal-group' if request['target'] < 0 else 'signal', *leader, str(number)]
            if request['target'] < 0:
                command += [':'.join((row[0], row[2], row[3])) for row in current.values() if int(row[0]) in members]
            result = subprocess.run(command, capture_output=True, text=True, timeout=2)
            if result.returncode not in (0, 3):
                raise ValueError('identity-fenced requested signal refused')
        if number == 9:
            deadline = time.monotonic() + 2
            while True:
                live = []
                for pid in members if members is not None else [request['target']]:
                    birth = current[pid]
                    result = subprocess.run([str(self.helper), 'status', *birth], capture_output=True, text=True, timeout=max(0.01, min(2, deadline - time.monotonic())))
                    if result.returncode == 0:
                        live.append(pid)
                    elif result.returncode != 3:
                        raise ValueError('post-signal process identity unobserved')
                if not live:
                    break
                if time.monotonic() >= deadline:
                    raise ValueError('recipient exit acknowledgement timed out')
                time.sleep(0.01)
            self.check_deaths(instrumented=True, required=True, deadline=deadline)

    def check_deaths(self, instrumented, required=False, deadline=None):
        if required and len(self.recipient_births) != 1:
            raise ValueError('exact recipient birth missing before post-exit approval')
        for birth in self.recipient_births.values():
            if deadline is not None and time.monotonic() >= deadline:
                raise ValueError('recipient exit acknowledgement timed out')
            result = subprocess.run([str(self.helper), 'status', *birth], capture_output=True, text=True, timeout=2 if deadline is None else max(0.01, min(2, deadline - time.monotonic())))
            if result.returncode == 0:
                if required:
                    raise ValueError('recipient remains alive before cleanup acknowledgement')
                continue
            if result.returncode != 3:
                raise ValueError('recipient death observation unresolved')
            for record in self.records.values():
                if 'postExit' in record:
                    continue
                try:
                    after = focused_profile.profile_state(record['state']['path'], record['expected'])
                except FileNotFoundError:
                    if instrumented:
                        raise ValueError('instrumented profile missing before true post-exit snapshot')
                    after = {'unobservable': True, 'reason': 'unobservable_missing'}
                if not after.get('unobservable') and after != record['state']:
                    raise ValueError('post-exit recipient profile changed')
                if tuple(birth) in self.cleanup_races:
                    after = {'unobservable': True, 'reason': 'unobservable_missing'}
                    self.cleanup_races_confirmed.add(tuple(birth))
                record['postExit'] = after


    def finish(self, instrumented):
        self.parent_close()
        try:
            if self.buffer or len(self.records) != 1 or len(self.observed) != 1:
                raise ValueError('exactly one approved recipient launch and plain exec observation required')
            if any(not record['livePolicies'] for record in self.records.values()):
                raise ValueError('live write-policy probes missing')
            self.check_deaths(instrumented, required=True)
            rows = []
            for record in self.records.values():
                try:
                    final = focused_profile.profile_state(record['state']['path'], record['expected'])
                except FileNotFoundError:
                    final = {'unobservable': True, 'reason': 'unobservable_missing'}
                after = record.get('postExit')
                if instrumented and (after is None or after.get('unobservable')):
                    raise ValueError('instrumented true post-exit snapshot missing')
                if not final.get('unobservable') and final != record['state']:
                    raise ValueError('recipient profile changed after approval')
                rows.append({'before': record['state'], 'after': after, 'finalObservation': final, 'declaration': record['layout'], 'liveWritePolicies': record['livePolicies']})
            return {'ok': True, 'cleanupRaceCounts': self.race_counts(), 'profiles': rows, 'requests': self.requests, 'observedRecipientBirths': [list(row) for row in self.observed], 'rendererEnvironmentKeys': sorted(self.renderer_env), 'acceptedLimit': 'Plain observation proves pinned reader identity/cwd, sandbox enabled, and live write policy matches the template at cellDir, delivery-content and sealed-root probe paths; it does not recover the exact profile consumed by sandbox_init. swap-and-restore between approval hash and sandbox-exec read is not detectable; accepted for reviewed pinned harness code (Queen 17:39Z and 17:44Z)', 'productionReadScope': 'read-open; reader FILE_READ_ROOT is an argv/env fixture constraint, not an SBPL read grant'}
        finally:
            self.close()
