# OpenCode V2 MCP Bridge

MCP-сервер, который позволяет **Cursor** (и любому другому MCP-клиенту) запускать
агентов **OpenCode V2** с выбранной моделью: `oc_task({ agent, model, prompt })`.

Написан потому, что популярные community-мосты (`opencode-mcp`,
`mcp-server-opencode`, `opencode-mcp-bridge` и т.п.) используют старый API OpenCode
(`/session`, `/agent`) и на OpenCode V2 возвращают HTML веб-приложения вместо JSON.

Работает через общий фоновый сервис OpenCode, поэтому сессии видны и в TUI, и в
Cursor. Пароль сервиса читается локально и никуда не отправляется.

## Требования

- OpenCode **V2** (`opencode --version`, проверено на 2.1.1)
- Node.js **22+**
- Cursor с поддержкой MCP (или любой MCP-клиент)
- Linux/macOS (Windows — см. раздел «Windows»)

## Установка

```bash
tar -xzf opencode-v2-mcp-bridge-1.0.0.tar.gz
cd opencode-v2-mcp-bridge
./install.sh
```

Скрипт:

1. копирует мост в `~/.config/opencode/mcp-bridge`;
2. добавляет сервер `opencode` в `~/.cursor/mcp.json` (существующие серверы сохраняются);
3. кладёт примеры агентов в `~/.config/opencode/agents` (если таких файлов ещё нет).

Затем **перезапустите Cursor**.

Опции:

```bash
./install.sh --dir ~/tools/opencode-mcp-bridge   # другой каталог установки
./install.sh --no-agents                        # не устанавливать агентов
```

Ручная установка:

```bash
mkdir -p ~/.config/opencode/mcp-bridge
cp -R dist run.sh README.md LICENSE ~/.config/opencode/mcp-bridge/
chmod +x ~/.config/opencode/mcp-bridge/run.sh
```

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "/home/<you>/.config/opencode/mcp-bridge/run.sh",
      "args": []
    }
  }
}
```

## Инструменты

| Инструмент | Назначение |
|---|---|
| `oc_agents` | Список агентов проекта: id, режим, модель |
| `oc_models` | Список моделей `provider/model`, фильтр по провайдеру |
| `oc_task` | Новая сессия для `agent` (+ `model`), промпт, ожидание результата |
| `oc_reply` | Продолжить существующую сессию |
| `oc_status` | Статус, агент, модель, стоимость, последний ответ |
| `oc_cancel` | Прервать выполнение |
| `oc_sessions` | Последние сессии проекта |

`oc_task` по умолчанию ждёт 50 секунд — это меньше типичного таймаута
MCP-клиента. Для длинных задач:

```
oc_task({ ..., background: true })  ->  sessionID
oc_status({ sessionID, waitSeconds: 120 })
```

## Модели

По умолчанию используется модель, заданная у агента. Если у агента модели нет,
он наследует модель родительской сессии (так же ведут себя его субагенты).

Переменные окружения (задаются в `~/.cursor/mcp.json` → `env`):

| Переменная | Значение |
|---|---|
| `OPENCODE_FORCE_MODEL` | Всегда использовать эту модель, игнорируя аргумент и конфиг агента |
| `OPENCODE_FALLBACK_MODEL` | Один автоматический повтор при `outcome: "failed"` |
| `OPENCODE_BASE_URL` | URL сервиса (по умолчанию определяется через `opencode service status`) |
| `OPENCODE_SERVER_USERNAME` | Basic-auth пользователь, по умолчанию `opencode` |
| `OPENCODE_SERVER_PASSWORD` | Пароль (по умолчанию читается из `service.json`) |
| `OPENCODE_DEFAULT_DIRECTORY` | Каталог проекта по умолчанию |

Ретрай не срабатывает для `background: true`, таймаутов, отмены и отказов в
permissions — чтобы не дублировать работу.

### Пример: бесплатная модель + платный fallback

```json
"env": {
  "OPENCODE_FORCE_MODEL": "opencode/deepseek-v4.1-flash-free",
  "OPENCODE_FALLBACK_MODEL": "deepseek/deepseek-flash"
}
```

`deepseek/deepseek-flash` — официальный id **DeepSeek-V4.1-Flash** у провайдера
`deepseek`. Чтобы он появился, добавьте провайдера в `~/.config/opencode/opencode.json`
(ключ — из `DEEPSEEK_API_KEY` или файла):

```jsonc
"providers": {
  "deepseek": {
    "name": "DeepSeek",
    "package": "aisdk:@ai-sdk/openai-compatible",
    "settings": {
      "baseURL": "https://api.deepseek.com",
      "apiKey": "{file:~/.config/opencode/deepseek.key}"
    },
    "models": {
      "deepseek-flash": {
        "name": "DeepSeek V4.1 Flash",
        "limit": { "context": 1048576, "output": 393216 }
      }
    }
  }
}
```

После правки: `opencode reload`.

В ответе `oc_task` при срабатывании fallback появляется блок:

```json
"fallback": {
  "from": "opencode/deepseek-v4.1-flash-free#default",
  "to": "deepseek/deepseek-flash",
  "reason": "Free usage limit reached...",
  "originalSessionID": "ses_..."
}
```

## Агенты

Глобальные: `~/.config/opencode/agents/<name>.md`.
Проектные: `.opencode/agents/<name>.md`.

Чтобы агента можно было запускать **из Cursor**, он должен быть `mode: all` или
`mode: primary`. Агенты `mode: subagent` запускаются только другим агентом OpenCode.

```md
---
description: Дешёвый read-only ревьюер
mode: all
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
---
Ты — лаконичный ревьюер. Не используй инструменты.
```

Модель в агенте можно не указывать — тогда он наследует модель сессии, и
`OPENCODE_FORCE_MODEL` / `OPENCODE_FALLBACK_MODEL` действуют на всю цепочку
включая субагентов.

## Диагностика

Проверить, что сервис жив:

```bash
opencode service status
```

Проверить мост вручную (MCP Inspector):

```bash
npx -y @modelcontextprotocol/inspector ~/.config/opencode/mcp-bridge/run.sh
```

Логи Cursor:

```bash
tail -40 "$(ls -dt ~/.cursor/logs/*/ 2>/dev/null | head -1)mcp-server-user-opencode.log"
# или
tail -40 "$(ls -dt ~/.config/Cursor/logs/*/ 2>/dev/null | head -1)mcp-server-user-opencode.log"
```

Типичные ошибки:

| Симптом | Причина / решение |
|---|---|
| `OpenCode service is not running` | `opencode service start` |
| `Connection closed` сразу после запуска | нет `node`/`opencode` в PATH — `run.sh` уже добавляет типовые пути; проверьте `NODE_BIN`/`OPENCODE_BIN` |
| `fetch failed` | неверный `OPENCODE_BASE_URL` или сервис перезапустился (пароль/порт изменились) — перезапустите MCP-сервер |
| `provider.quota` / `Free usage limit reached` | сработает fallback, если задан `OPENCODE_FALLBACK_MODEL` |
| Инструменты не появились | перезапустите Cursor или MCP-сервер в настройках |

## Windows

`run.sh` рассчитан на bash. Варианты:

- WSL + Cursor в WSL;
- запускать напрямую: `node dist/index.mjs` с переменными
  `OPENCODE_BASE_URL`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_DEFAULT_DIRECTORY`;
- либо добавить в `mcp.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["C:/path/to/opencode-v2-mcp-bridge/dist/index.mjs"],
      "env": { "OPENCODE_BASE_URL": "http://127.0.0.1:4096", "OPENCODE_SERVER_PASSWORD": "..." }
    }
  }
}
```

## Безопасность

Мост не хранит секретов: URL и пароль читаются из локального сервиса OpenCode
(`opencode service status`, `~/.config/opencode/service.json`). Наружу ничего не
отправляется, кроме запросов к вашему локальному OpenCode.

## Лицензия

MIT.
