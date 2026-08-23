export class MissingElementError extends Error {
  readonly name = "MissingElementError";
  constructor(readonly elementId: string) {
    super(`missing companion element #${elementId}`);
  }
}

export function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new MissingElementError(id);
  return found;
}

export function setSubtitle(first: string, second: string): void {
  const subtitle = element("sub");
  subtitle.replaceChildren(document.createTextNode(first), document.createElement("br"), document.createTextNode(second));
}
