import { connect, isIP } from 'node:net';

export async function certificateRejection(send, kind) {
  const codes = kind === 'hostname'
    ? ['ERR_TLS_CERT_ALTNAME_INVALID']
    : ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'];
  try {
    await send();
    return { pass: false, reason: 'TLS_ACCEPTED', layer: 'tls' };
  } catch (error) {
    const reason = error.code ?? 'UNKNOWN_ERROR';
    return { pass: codes.includes(reason), reason, layer: codes.includes(reason) ? (kind === 'hostname' ? 'certificate_hostname' : 'certificate_trust') : 'unexpected_failure' };
  }
}

// A connect event is sufficient to disprove isolation, whatever protocol follows.
export function probeTcp(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    let resolved = isIP(host) !== 0;
    socket.once('lookup', error => { if (!error) resolved = true; });
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done({ reachable: true, reason: 'TCP_CONNECTED', layer: 'tcp' }));
    socket.once('error', error => {
      const reason = error.code ?? 'UNKNOWN_ERROR';
      const layer = ['ENOTFOUND', 'EAI_AGAIN'].includes(reason) ? 'dns_unavailable'
        : reason === 'ECONNREFUSED' ? 'tcp_refused'
        : ['EHOSTUNREACH', 'ENETUNREACH'].includes(reason) ? 'network_unreachable'
        : 'unexpected_failure';
      done({ reachable: false, reason, layer });
    });
    socket.setTimeout(timeout, () => done({ reachable: false, reason: 'TIMEOUT', layer: resolved ? 'tcp_timeout' : 'dns_timeout' }));
  });
}
