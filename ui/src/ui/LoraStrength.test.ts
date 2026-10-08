import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatStrength, LORA_ADD_VALUE, LoraStrength, parseStrength, sliderPosition } from "./LoraStrength";

// The owner's spec for every LoRA strength control: added at 70; a 0-200 slider with a
// notch at 100 marked "ideal"; the number can be clicked and ANY value typed; a value
// over 200 leaves the slider at its right edge, a negative one at its left.

describe("LoRA strength rules", () => {
  it("adds at 70", () => expect(LORA_ADD_VALUE).toBe(70));

  it("pins the slider to its edges without changing the value", () => {
    expect(sliderPosition(70)).toBe(70);
    expect(sliderPosition(250)).toBe(200);
    expect(sliderPosition(-30)).toBe(0);
    expect(sliderPosition(Number.NaN)).toBe(0);
  });

  it("parses anything numeric, and nothing else", () => {
    expect(parseStrength(" 250 ")).toBe(250);
    expect(parseStrength("-12.5")).toBe(-12.5);
    expect(parseStrength("12,5")).toBe(12.5);
    expect(parseStrength("")).toBeNull();
    expect(parseStrength("loud")).toBeNull();
    expect(parseStrength("Infinity")).toBeNull();
  });

  it("shows whole numbers plainly and anything else to two places", () => {
    expect(formatStrength(70)).toBe("70");
    expect(formatStrength(-25.5)).toBe("-25.5");
    expect(formatStrength(1 / 3)).toBe("0.33");
  });
});

describe("LoraStrength", () => {
  let host: HTMLDivElement;
  let root: Root;
  let seen: number[];

  function Harness({ start }: { start: number }) {
    const [value, setValue] = useState(start);
    return React.createElement(LoraStrength, {
      label: "Keeper", value, onChange: (next: number) => { seen.push(next); setValue(next); },
    });
  }
  const render = (start = LORA_ADD_VALUE) => act(() => root.render(React.createElement(Harness, { start })));
  const slider = () => host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const number = () => host.querySelector<HTMLButtonElement>(".lora-strength-num");
  const field = () => host.querySelector<HTMLInputElement>(".lora-strength-input");
  const setValue = (el: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (el: HTMLElement, k: string) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const typeValue = (text: string, finish = "Enter") => {
    act(() => number()!.click());
    setValue(field()!, text);
    key(field()!, finish);
  };

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    seen = [];
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("is a 0-200 slider with an 'ideal' notch at its centre, and shows the value", () => {
    render();
    expect(slider().min).toBe("0");
    expect(slider().max).toBe("200");
    expect(slider().value).toBe("70");
    expect(slider().getAttribute("aria-label")).toBe("Keeper strength");
    expect(host.querySelector(".lora-strength-ideal")?.textContent).toBe("ideal");
    expect(host.querySelector<HTMLElement>(".lora-strength-notch")?.getAttribute("title")).toBe("100: ideal");
    expect(number()?.textContent).toBe("70");
  });

  it("takes any typed value: over 200 pins the slider right, negative pins it left", () => {
    render();
    typeValue("250");
    expect(seen).toEqual([250]);
    expect(number()?.textContent).toBe("250");
    expect(slider().value).toBe("200");

    typeValue("-40");
    expect(number()?.textContent).toBe("-40");
    expect(slider().value).toBe("0");

    // Back inside the range, the slider follows again.
    typeValue("120");
    expect(slider().value).toBe("120");
  });

  it("drops an edit that is not a number, and Escape cancels", () => {
    render(90);
    typeValue("loud");
    typeValue("150", "Escape");
    expect(seen).toEqual([]);
    expect(number()?.textContent).toBe("90");
    expect(field()).toBeNull();
  });

  it("commits a typed value when the field loses focus", () => {
    render();
    act(() => number()!.click());
    setValue(field()!, "33.5");
    act(() => { field()!.blur(); });
    expect(seen).toEqual([33.5]);
    expect(number()?.textContent).toBe("33.5");
  });

  it("moves with the slider", () => {
    render();
    setValue(slider(), "180");
    expect(seen).toEqual([180]);
    expect(number()?.textContent).toBe("180");
  });
});
