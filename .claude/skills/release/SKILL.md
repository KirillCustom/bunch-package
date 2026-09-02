---
name: release
description: Выпуск новой версии bunch-package — от подъёма версии до проверки, что пакет появился в npm. Вызывать, когда в main накопились правки и решено выпускать релиз.
---

# Выпуск версии

Публикацию в npm и в GitHub Packages делают workflow, и запускает их **создание GitHub Release**. Поэтому забыть тег или релиз — значит не выпустить: `main` обновится, а пользователи ничего не получат. Локальный токен в `~/.npmrc` протух и не нужен — публикация идёт через OIDC от GitHub Actions.

## Какую цифру брать

- **минорная** (1.14.0 → 1.15.0) — появилась команда, флаг или поведение, которого не было;
- **патч** (1.14.0 → 1.14.1) — только исправления, ничего не добавилось.

## Последовательность

```bash
# 1. Ветка и подъём версии в package.json (единственное место, где она лежит)
git checkout -q main && git pull -q
git checkout -b release/X.Y.Z
# ... поднять "version" в package.json ...
git commit -F -   # сообщение по-английски, одной фразой о сути релиза

# 2. PR и ожидание шести проверок
git push -u origin release/X.Y.Z
gh pr create --base main --head release/X.Y.Z --title "Release X.Y.Z" --body "..."
until [ "$(gh pr checks <N> 2>/dev/null | grep -c pending)" = "0" ]; do sleep 20; done
gh pr checks <N>          # six passes: old-bun 1.0.36 / 1.1.45 / 1.2.23, test ubuntu / macos / windows

# 3. Слияние и уборка ветки
gh pr merge <N> --merge --subject "Merge pull request #<N>: release X.Y.Z"
git checkout -q main && git pull -q
git push origin --delete release/X.Y.Z && git branch -d release/X.Y.Z

# 4. Тег — с него и начинается публикация
git tag vX.Y.Z && git push origin vX.Y.Z

# 5. Релиз с заметками (файл заметок — в песочницу, не в репозиторий)
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <файл>

# 6. Проверить, что вышло
until [ "$(gh run list --limit 3 | grep -c 'in_progress\|queued')" = "0" ]; do sleep 15; done
gh run list --limit 3      # ожидание: Publish to npm и Publish to GitHub Packages — success

# 7. Дождаться реестра — он отвечает не сразу
until [ "$(npm view bunch-package version 2>/dev/null)" = "X.Y.Z" ]; do sleep 20; done

# 8. Поставить опубликованное и позвать
cd <песочница> && echo '{"name":"s","version":"1.0.0"}' > package.json
bun add -d bunch-package@X.Y.Z
bunx bunch-package | head -20    # команды этой версии на месте?
```

**`success` у workflow не значит «уже в реестре».** npm отвечает `Your package is
being processed and may take a few minutes to become available`, и первые минуты
`dist-tags.latest` показывает **предыдущую** версию. Признак того, что публикация
действительно состоялась, — строка `+ bunch-package@X.Y.Z` в конце лога задания:

```bash
gh run view <id> --log | grep -E '^\+ bunch-package@|npm error'
```

Проверять реестр сразу после workflow и делать вывод по одному ответу — значит
получить ложную тревогу; так уже было дважды.

**Дымовая установка обязательна.** Публикуется не репозиторий, а тарбол, который
собирает `prepublishOnly`; в нём лежит `dist/index.js`, которого в git нет вовсе.
Единственная проверка, что уехало именно то, что нужно, — поставить пакет из
реестра и позвать его. Место известно ненадёжное: `--provenance` и способ
аутентификации чинились здесь четырьмя коммитами подряд.

## Заметки к релизу

Разделы `## Added` / `## Fixed` / `## Changed` / `## Verified`, по-английски, и **ни одного неизмеренного утверждения**. В каждом пункте — что было не так и чем это подтверждено: числа корпуса, миллисекунды замеров, число тестов и мутаций. Заканчивать ссылкой:

```
**Full Changelog**: https://github.com/KirillCustom/bunch-package/compare/vПРЕД...vX.Y.Z
```

Заметки прошлых релизов — образец тона: `gh release view v1.14.0`.

## После выпуска

Закрыть задачи в mIOnika (`update_task_status` со статусом `done` и `commitId` merge-коммита) и убедиться, что веток, кроме `main`, не осталось:

```bash
gh api repos/KirillCustom/bunch-package/branches --jq '.[].name'
```
