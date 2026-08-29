/**
 * Body params the proxy owns on every outbound request.
 *
 * `model` carries the resolved routing target and `stream` decides how both the
 * upstream response and the client response are framed, so an endpoint policy
 * that set or stripped either would leave the proxy parsing a shape it did not
 * ask for. The remaining names are prototype-pollution vectors on the plain
 * object an outbound body is built from.
 *
 * Shared because three layers enforce it: the admin editor rejects these at edit
 * time, the admin API rejects them at persist time, and applyBodyParamPolicy
 * ignores them at request time as the backstop for a hand-edited endpoints.json.
 */
export const RESERVED_BODY_PARAMS: readonly string[] = [
  "model",
  "stream",
  "__proto__",
  "constructor",
  "prototype",
];

const RESERVED_BODY_PARAM_SET = new Set(RESERVED_BODY_PARAMS);

export function isReservedBodyParam(name: string): boolean {
  return RESERVED_BODY_PARAM_SET.has(name.toLowerCase());
}
