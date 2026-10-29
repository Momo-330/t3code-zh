import { describe, expect, it } from "vitest";
import {
  inferMagpieRoutingForInstanceModel,
  isMagpieGatewayUrl,
  isMagpieOpenAiCatalogModel,
  readMagpieGatewayUrlFromInstanceEnvironment,
  shouldMarkModelRoutedViaMagpie,
} from "./magpieRouting";

describe("isMagpieGatewayUrl", () => {
  it("recognizes magpie hostnames and the default local gateway port", () => {
    expect(isMagpieGatewayUrl("http://127.0.0.1:3425/v1")).toBe(true);
    expect(isMagpieGatewayUrl("http://localhost:3425")).toBe(true);
    expect(isMagpieGatewayUrl("https://magpie.local/v1")).toBe(true);
    expect(isMagpieGatewayUrl("https://api.openai.com/v1")).toBe(false);
    expect(isMagpieGatewayUrl("http://127.0.0.1:8080/v1")).toBe(false);
  });
});

describe("isMagpieOpenAiCatalogModel", () => {
  it("detects magpie_label on catalog entries", () => {
    expect(isMagpieOpenAiCatalogModel({ id: "codex/gpt-6.1-sol", magpie_label: "Codex" })).toBe(
      true,
    );
    expect(
      isMagpieOpenAiCatalogModel({
        id: "gpt-5",
        display_name: "GPT-5",
        owned_by: "openai",
      }),
    ).toBe(false);
  });
});

describe("shouldMarkModelRoutedViaMagpie", () => {
  it("prefers gateway base URLs and magpie catalog metadata", () => {
    expect(
      shouldMarkModelRoutedViaMagpie({ baseUrl: "http://127.0.0.1:3425/v1", slug: "gpt-5" }),
    ).toBe(true);
    expect(
      shouldMarkModelRoutedViaMagpie({
        catalogModel: { id: "anthropic/claude-sonnet-5", magpie_label: "Anthropic" },
      }),
    ).toBe(true);
    expect(shouldMarkModelRoutedViaMagpie({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
  });
});

describe("readMagpieGatewayUrlFromInstanceEnvironment", () => {
  it("reads configured gateway env vars", () => {
    expect(
      readMagpieGatewayUrlFromInstanceEnvironment([
        { name: "OPENAI_BASE_URL", value: "http://127.0.0.1:3425/v1" },
      ]),
    ).toBe("http://127.0.0.1:3425/v1");
    expect(
      readMagpieGatewayUrlFromInstanceEnvironment([
        { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:3425" },
      ]),
    ).toBe("http://127.0.0.1:3425");
  });
});

describe("inferMagpieRoutingForInstanceModel", () => {
  it("marks magpie-shaped slugs when the instance gateway points at magpie", () => {
    expect(
      inferMagpieRoutingForInstanceModel({
        slug: "codex/gpt-6.1-sol",
        instanceUsesMagpieGateway: true,
      }),
    ).toBe(true);
    expect(
      inferMagpieRoutingForInstanceModel({
        slug: "gpt-5.4",
        instanceUsesMagpieGateway: true,
      }),
    ).toBe(false);
  });
});
