import { describe, expect, it } from "vitest";
import {
  formatMessage,
  getMessages,
  localizeApiError,
} from "./messages";

describe("web translations", () => {
  it("formats interpolated messages for both locales", () => {
    expect(
      formatMessage(getMessages("en").dashboard.greeting, { name: "Alice" }),
    ).toBe("Hello, Alice");
    expect(
      formatMessage(getMessages("zh-CN").dashboard.greeting, {
        name: "Alice",
      }),
    ).toBe("你好，Alice");
  });

  it("localizes known API errors", () => {
    expect(
      localizeApiError(
        new Error("Invalid email, username, or password"),
        getMessages("en"),
      ),
    ).toBe("Invalid email, username, or password");
    expect(
      localizeApiError(
        new Error("Invalid email, username, or password"),
        getMessages("zh-CN"),
      ),
    ).toBe("邮箱、用户名或密码错误");
  });

  it("falls back to a localized request error for empty errors", () => {
    expect(localizeApiError(null, getMessages("zh-CN"))).toBe("请求失败");
  });
});
