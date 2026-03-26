import { describe, expect, it } from "vitest";
import {
  cssRectToCanvasPixels,
  isExcalidrawTextEditActive,
  isStandaloneTextBeingEdited,
  pickEditingTextElement,
  textareaDestRectCss,
} from "./excalidrawViewportTextOverlayHelpers";

describe("isExcalidrawTextEditActive", () => {
  it("is true for container-bound text", () => {
    expect(
      isExcalidrawTextEditActive({
        editingTextElement: { type: "text", containerId: "r1", text: "x" },
      })
    ).toBe(true);
  });

  it("is true for new text element", () => {
    expect(
      isExcalidrawTextEditActive({
        newElement: { type: "text", text: "" },
      })
    ).toBe(true);
  });
});

describe("pickEditingTextElement", () => {
  it("prefers editingTextElement over newElement", () => {
    const ed = { type: "text" as const, id: "a" };
    const ne = { type: "text" as const, id: "b" };
    expect(
      pickEditingTextElement({ editingTextElement: ed, newElement: ne })
    ).toBe(ed);
  });
});

describe("isStandaloneTextBeingEdited", () => {
  it("is false when not editing", () => {
    expect(isStandaloneTextBeingEdited({ editingTextElement: null })).toBe(false);
  });

  it("is false for bound / container text", () => {
    expect(
      isStandaloneTextBeingEdited({
        editingTextElement: { type: "text", containerId: "box-1" },
      })
    ).toBe(false);
  });

  it("is true for standalone text", () => {
    expect(
      isStandaloneTextBeingEdited({
        editingTextElement: { type: "text", containerId: null, text: "hi" },
      })
    ).toBe(true);
  });
});

describe("cssRectToCanvasPixels", () => {
  it("maps CSS box to output pixel rect", () => {
    const r = cssRectToCanvasPixels(
      { left: 10, top: 20, width: 100, height: 40 },
      200,
      400,
      400,
      800
    );
    expect(r).toEqual({ dx: 20, dy: 40, dw: 200, dh: 80 });
  });
});

describe("textareaDestRectCss", () => {
  it("returns offset relative to container", () => {
    const container = document.createElement("div");
    const ta = document.createElement("textarea");
    container.appendChild(ta);
    document.body.appendChild(container);
    container.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 500, height: 500, right: 600, bottom: 550, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
    ta.getBoundingClientRect = () =>
      ({ left: 130, top: 80, width: 200, height: 24, right: 330, bottom: 104, x: 130, y: 80, toJSON: () => ({}) }) as DOMRect;

    expect(textareaDestRectCss(container, ta)).toEqual({
      left: 30,
      top: 30,
      width: 200,
      height: 24,
    });

    document.body.removeChild(container);
  });
});
