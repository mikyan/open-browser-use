// Private process-local metadata. The ticket never enters CDP parameters or a
// page world; it names the original attachment and progress deadline.
const tickets = new WeakMap();

export function tagPointerCommand(params, ticket) {
  if (ticket !== undefined) {
    if (!params || typeof params !== "object" || typeof ticket?.check !== "function")
      throw new Error("OBU_POINTER_GUARD_INVALID: invalid native pointer ticket");
    ticket.check();
    tickets.set(params, ticket);
  }
  return params;
}

export function pointerCommandGuard(params) {
  return params && typeof params === "object" ? tickets.get(params) : undefined;
}
