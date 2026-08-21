import { Sheet, el, button, list, groupRow, tapRow } from "../../ui.js";
import { t } from "../../i18n.js";
import { showWelcome } from "../../panels.js";

export function showSettings(app) {
  const sheet = new Sheet(t("settings.title"));
  const ul = list();
  const again = () => { sheet.close(); showSettings(app); };

  ul.append(groupRow(t("settings.group.explain")));
  ul.append(tapRow(t("settings.explainOn"), {
    sub: t("settings.explainOnSub"),
    right: app.prefs.explain ? "✓" : "",
    onTap: () => { app.setExplain(!app.prefs.explain); again(); },
  }));
  if (app.prefs.explain) {
    for (const [key, label, sub] of [
      ["ja", t("settings.note.ja"), t("settings.note.jaSub")],
      ["pseudo", t("settings.note.pseudo"), t("settings.note.pseudoSub")],
      ["both", t("settings.note.both"), t("settings.note.bothSub")],
    ]) {
      ul.append(tapRow(label, {
        indent: true, sub,
        right: (app.prefs.noteStyle || "ja") === key ? "✓" : "",
        onTap: () => { app.setNoteStyle(key); again(); },
      }));
    }
  }

  ul.append(groupRow(t("settings.group.appearance")));
  for (const [key, label] of [
    ["system", t("settings.theme.system")],
    ["light", t("settings.theme.light")],
    ["dark", t("settings.theme.dark")],
  ]) {
    ul.append(tapRow(label, {
      right: app.store.get("theme") === key ? "✓" : "",
      onTap: () => { app.setTheme(key); again(); },
    }));
  }
  const sizes = [["s", t("settings.size.s")], ["m", t("settings.size.m")],
                 ["l", t("settings.size.l")], ["xl", t("settings.size.xl")]];
  const sizeRow = el("li");
  sizeRow.append(el("span", "k", t("settings.textSize")));
  const sizeChips = el("div", "chips inline");
  for (const [key, label] of sizes) {
    const c = button(label, "chip", () => { app.setTextSize(key); again(); });
    c.setAttribute("aria-pressed", String((app.prefs.textSize || "m") === key));
    sizeChips.append(c);
  }
  sizeRow.append(sizeChips);
  ul.append(sizeRow);

  ul.append(groupRow(t("settings.group.hex")));
  ul.append(tapRow(t("settings.hexSpaced"), {
    sub: "F6 57 BD A9",
    right: app.store.get("hexJoined") ? "" : "✓",
    onTap: () => { app.setHexJoined(false); again(); },
  }));
  ul.append(tapRow(t("settings.hexJoined"), {
    sub: "F657BDA9",
    right: app.store.get("hexJoined") ? "✓" : "",
    onTap: () => { app.setHexJoined(true); again(); },
  }));

  ul.append(groupRow(t("settings.group.lang")));
  for (const [key, label] of [["ja", t("settings.lang.ja")], ["en", t("settings.lang.en")]]) {
    ul.append(tapRow(label, {
      right: (app.prefs.lang || "ja") === key ? "✓" : "",
      onTap: () => { app.setLanguage(key); sheet.close(); showSettings(app); },
    }));
  }

  ul.append(groupRow(t("settings.group.about")));
  const li = el("li");
  li.append(el("span", "sub", t("settings.about", { version: app.capstoneVersion || "5" })));
  ul.append(li);
  ul.append(tapRow(t("settings.resetGuide"), {
    onTap: () => { sheet.close(); showWelcome(app, true); },
  }));

  sheet.body.append(ul);
}
