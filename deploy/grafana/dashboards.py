#!/usr/bin/env python3
"""Writes the two Grafana dashboards, veeam-overview.json and veeam-job.json.

The JSON is generated: change this file and run

    python3 deploy/grafana/dashboards.py

Grafana reads the files on its next provisioning pass; the UI cannot save over them.
"""
import json
import os
import sys

DS = {"type": "prometheus", "uid": "veeam-prometheus"}
S = '{server=~"$server"}'
J = '{server="$server", job_name="$job"}'
OVERVIEW_URL = "/d/veeam-overview/veeam-obzor"
JOB_URL = "/d/veeam-job/veeam-zadanie?var-server=${__data.fields.server:percentencode}&var-job=${__data.fields.job_name:percentencode}&${__url_time_range}"
SERVER_URL = OVERVIEW_URL + "?var-server=${__data.fields.server:percentencode}&${__url_time_range}"
HIDDEN = ["Time", "__name__", "instance", "job", "job_id", "repository_id"]
WEEK = 7 * 86400


def sel(**labels):
    return "{" + ", ".join(['server=~"$server"'] + [f'{k}="{v}"' for k, v in labels.items()]) + "}"


def job_sel(**labels):
    return "{" + ", ".join(['server="$server"', 'job_name="$job"'] + [f'{k}="{v}"' for k, v in labels.items()]) + "}"


# --- What counts as a problem -------------------------------------------------
# A job counts when it is enabled and alive: it ran within the week, or Veeam
# has its next run scheduled. A job that failed two months ago and has not run
# since is not news; it is listed apart, folded, at the bottom of the overview.
ENABLED = f"(veeam_job_disabled{S} == 0)"
ALIVE = f"((time() - veeam_job_last_run_timestamp_seconds{S}) < {WEEK} or veeam_job_next_run_timestamp_seconds{S} > time())"


def live(expr):
    return f"({expr} and on (server, job_id) {ENABLED} and on (server, job_id) {ALIVE})"


def abandoned(expr):
    return f"({expr} and on (server, job_id) {ENABLED} unless on (server, job_id) {ALIVE})"


FAILED = live(f"veeam_job_last_result{S} == 2")
WARNED = live(f"veeam_job_last_result{S} == 1")
ATTENTION = live(f"veeam_job_last_result{S} >= 1")
STUCK = abandoned(f"veeam_job_last_result{S} >= 1")

# --- Repositories --------------------------------------------------------------
# One storage added to several Veeam servers is reported by each of them, under
# the same name. It is shown once, by name. The Default Backup Repository is
# the exception: every server has its own, so it keeps the server's name.
DEFAULT_REPO = "Default Backup Repository"


def repo_pct(part, extra=""):
    s = '{server=~"$server"' + extra + "}"
    return f"100 * veeam_repository_{part}_bytes{s} / veeam_repository_capacity_bytes{s}"


def per_storage(part, agg):
    own = repo_pct(part, f', repository="{DEFAULT_REPO}"')
    shared = repo_pct(part, f', repository!="{DEFAULT_REPO}"')
    return (f'{agg} by (repository) ({shared} or label_replace({own}, "repository", "{DEFAULT_REPO} · $1", "server", "(.+)"))')


# --- Panels ----------------------------------------------------------------------
class Ids:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return self.n


def target(expr, ref="A", legend="", instant=False, fmt="time_series"):
    t = {"datasource": DS, "refId": ref, "expr": expr, "legendFormat": legend or "__auto", "range": not instant, "instant": instant}
    if fmt != "time_series":
        t["format"] = fmt
    return t


def thresholds(*steps):
    return {"mode": "absolute", "steps": [{"value": v, "color": c} for v, c in steps]}


def vmap(pairs):
    return [{"type": "value", "options": {str(v): {"text": t, "color": c, "index": i} for i, (v, t, c) in enumerate(pairs)}}]


RESULT_MAP = vmap([(2, "Ошибка", "red"), (1, "Предупреждение", "orange"), (0, "Успешно", "green"), (-1, "Нет результата", "text")])
RESULT_COLORS = thresholds((None, "green"), (1, "orange"), (2, "red"))
JOB_LINK = [{"title": "Подробнее о задании", "url": JOB_URL}]
SERVER_LINK = [{"title": "Показать только этот сервер", "url": SERVER_URL}]
# Weighted so that the worst state of a server's configuration backup wins.
CONFIG_CODE = " + ".join(f'{weight} * sum by (server) (veeam_config_backup_state{sel(state=state)})'
                         for weight, state in ((4, "never"), (3, "failed"), (2, "stale"), (1, "unencrypted")))
CONFIG_MAP = vmap([(0, "В порядке", "green"), (1, "Без шифрования", "orange"), (2, "Устарел", "orange"), (3, "Упал", "red"), (4, "Не делается", "red")])
BACKGROUND = {"type": "color-background", "mode": "basic"}


def _days(n):
    return f"{n} дня" if n < 5 else f"{n} дней"


# Hours ago, said the way a person would: Grafana's own "from now" unit speaks English only.
AGO = [{"type": "range", "options": {"from": lo, "to": hi, "result": {"text": text, "index": i}}} for i, (lo, hi, text) in enumerate(
    [(-1e9, 1, "меньше часа назад")]
    + [(24 * d, 24 * (d + 1), f"{_days(d)} назад") for d in range(2, 7)]
    + [(168, 336, "больше недели назад"), (336, 720, "больше 2 недель назад"), (720, 1e9, "больше месяца назад")])]
AGO_UNIT = "suffix: ч назад"


def hours_since(metric):
    return f"(time() - {metric}) / 3600"


def override(field, *props):
    return {"matcher": {"id": "byName", "options": field}, "properties": [{"id": k, "value": v} for k, v in props]}


def override_by_type(kind, *props):
    return {"matcher": {"id": "byType", "options": kind}, "properties": [{"id": k, "value": v} for k, v in props]}


class Board:
    def __init__(self):
        self.pid = Ids()
        self.panels = []

    def add(self, panel):
        self.panels.append(panel)
        return panel

    def stat(self, title, x, y, w, h, targets, *, unit="none", th=None, mappings=None, text_mode="auto", color_mode="background",
             description="", decimals=None, no_value="0", text=None, links=None, overrides=(), orientation="auto"):
        defaults = {"unit": unit, "thresholds": th or thresholds((None, "green")), "mappings": mappings or [], "color": {"mode": "thresholds"}, "noValue": no_value}
        if decimals is not None:
            defaults["decimals"] = decimals
        if links:
            defaults["links"] = links
        options = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                   "colorMode": color_mode, "graphMode": "none", "textMode": text_mode, "justifyMode": "center",
                   "orientation": orientation, "wideLayout": True, "showPercentChange": False}
        if text:
            options["text"] = text
        return self.add({"id": self.pid(), "type": "stat", "title": title, "description": description, "datasource": DS,
                         "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
                         "fieldConfig": {"defaults": defaults, "overrides": list(overrides)}, "options": options})

    def timeseries(self, title, x, y, w, h, targets, *, unit="none", stack=False, draw="line", description="", min_=None, max_=None,
                   legend_calcs=None, decimals=None, step=False, points=False):
        custom = {"drawStyle": draw, "lineWidth": 2, "fillOpacity": 25 if draw == "bars" else 10, "showPoints": "always" if points else "never",
                  "pointSize": 6, "spanNulls": True if step else False, "lineInterpolation": "stepAfter" if step else "linear",
                  "stacking": {"mode": "normal" if stack else "none", "group": "A"}, "axisSoftMin": 0}
        defaults = {"unit": unit, "custom": custom, "color": {"mode": "palette-classic"}, "thresholds": thresholds((None, "green"))}
        for key, value in (("decimals", decimals), ("min", min_), ("max", max_)):
            if value is not None:
                defaults[key] = value
        return self.add({"id": self.pid(), "type": "timeseries", "title": title, "description": description, "datasource": DS,
                         "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
                         "fieldConfig": {"defaults": defaults, "overrides": []},
                         "options": {"legend": {"displayMode": "table" if legend_calcs else "list", "placement": "right" if legend_calcs else "bottom",
                                                "showLegend": True, "calcs": legend_calcs or []},
                                     "tooltip": {"mode": "multi", "sort": "desc"}}})

    def table(self, title, x, y, w, h, targets, *, renames, order, overrides, hide=(), sort=None, description="", merge=True, no_value="—",
              sort_key=None):
        """`sort` orders by one shown column; `sort_key` by a hidden one, when the order needs more than one column."""
        transformations = []
        if merge:
            transformations.append({"id": "merge", "options": {}})
        if sort_key:
            transformations.append({"id": "sortBy", "options": {"fields": {}, "sort": [{"field": sort_key, "desc": True}]}})
            hide = (*hide, sort_key)
        transformations.append({"id": "organize", "options": {
            "excludeByName": {k: True for k in list(HIDDEN) + list(hide)},
            "indexByName": {k: i for i, k in enumerate(order)},
            "renameByName": renames}})
        # Overrides match a field by the name it is shown under, which the organize step renames.
        overrides = [{**o, "matcher": {**o["matcher"], "options": renames.get(o["matcher"]["options"], o["matcher"]["options"])}} for o in overrides]
        if sort:
            transformations.append({"id": "sortBy", "options": {"fields": {}, "sort": [{"field": f, "desc": d} for f, d in sort]}})
        if no_value != "—":
            # The panel-wide "no value" is what an empty table says; its cells keep a dash.
            overrides = [override_by_type(kind, ("noValue", "—")) for kind in ("number", "string")] + overrides
        return self.add({"id": self.pid(), "type": "table", "title": title, "description": description, "datasource": DS,
                         "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets, "transformations": transformations,
                         "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}, "filterable": True, "inspect": True},
                                                      "thresholds": thresholds((None, "green")), "mappings": [], "noValue": no_value},
                                         "overrides": overrides},
                         "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False, "reducer": ["sum"], "fields": ""}}})

    def bars(self, title, x, y, w, h, expr, legend, *, description=""):
        return self.add({
            "id": self.pid(), "type": "bargauge", "title": title, "description": description, "datasource": DS,
            "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": [target(expr, instant=True, legend=legend)],
            "fieldConfig": {"defaults": {"unit": "percent", "min": 0, "max": 100, "decimals": 0, "color": {"mode": "thresholds"},
                                         "thresholds": thresholds((None, "green"), (80, "orange"), (90, "red"))}, "overrides": []},
            "options": {"orientation": "horizontal", "displayMode": "gradient", "showUnfilled": True, "valueMode": "color", "namePlacement": "left",
                        "sizing": "manual", "minVizHeight": 16, "maxVizHeight": 22, "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}},
        })

    def row(self, title, y, collapsed_panels=None):
        panel = {"id": self.pid(), "type": "row", "title": title, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1},
                 "collapsed": collapsed_panels is not None, "panels": collapsed_panels or []}
        return self.add(panel)

    def folded(self, title, y, panel):
        """A row that opens on a click, holding one full-width panel."""
        self.panels.remove(panel)
        panel["gridPos"] = {**panel["gridPos"], "x": 0, "y": y + 1, "w": 24}
        return self.row(title, y, collapsed_panels=[panel])


def dashboard(uid, title, description, panels, templating, time_from, links):
    return {
        "uid": uid, "title": title, "description": description, "tags": ["veeam"], "timezone": "browser", "editable": True,
        "graphTooltip": 1, "refresh": "1m", "schemaVersion": 39, "version": 1, "time": {"from": time_from, "to": "now"},
        "timepicker": {}, "fiscalYearStartMonth": 0, "liveNow": False, "weekStart": "monday", "links": links,
        "annotations": {"list": []}, "templating": {"list": templating}, "panels": panels,
    }


def server_variable(multi):
    return {
        "name": "server", "label": "Сервер", "type": "query", "datasource": DS,
        "query": {"query": "label_values(veeam_server_up, server)", "refId": "server"},
        "definition": "label_values(veeam_server_up, server)",
        "refresh": 2, "sort": 1, "multi": multi, "includeAll": multi, **({"allValue": ".*"} if multi else {}),
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]} if multi else {},
        "options": [], "hide": 0, "skipUrlSync": False, "regex": "",
    }


# =============================================================================
# Overview: the verdict first, the details further down.
# =============================================================================
o = Board()
y = 0
o.stat("Бот", 0, y, 3, 4, [target('max(up{job="veeam-monitor"}) or vector(0)', instant=True)],
       mappings=vmap([(1, "Работает", "green"), (0, "Не отвечает", "red")]), th=thresholds((None, "red"), (1, "green")),
       description="Отвечает ли сам бот: всё остальное на этой странице — то, что он прочитал. Если он не отвечает, остальные панели пусты.")
o.stat("Серверы Veeam", 3, y, 4, 4, [target(f"count(veeam_server_up{S} == 0) or count(veeam_server_up{S}) * 0", instant=True)],
       unit="suffix: без связи", mappings=vmap([(0, "Все на связи", "green")]), th=thresholds((None, "green"), (1, "red")), no_value="Нет данных",
       description="Сколько серверов Veeam не ответили боту на последнем цикле. Какие — в таблице «Серверы» ниже.")
o.stat("Упали", 7, y, 3, 4, [target(f"count{FAILED} or vector(0)", instant=True)], th=thresholds((None, "green"), (1, "red")),
       description="Включённые задания, чей последний запуск закончился ошибкой, — те, что запускались за последнюю неделю или стоят в расписании. "
                   "Отключённые и давно брошенные сюда не входят: они внизу, в разделе «Давно в ошибке».")
o.stat("Предупреждения", 10, y, 4, 4, [target(f"count{WARNED} or vector(0)", instant=True)], th=thresholds((None, "green"), (1, "orange")),
       description="Как «Упали», но последний запуск закончился предупреждением.")
o.stat("Идут сейчас", 14, y, 3, 4, [target(f"sum(veeam_job_running{S}) or vector(0)", instant=True)], th=thresholds((None, "blue")),
       description="Задания, которые Veeam выполняет прямо сейчас.")
o.stat("Бэкап конфигурации", 17, y, 4, 4, [target('count(veeam_config_backup_state{server=~"$server", state!="ok"} == 1) or vector(0)', instant=True)],
       unit="suffix:  с проблемой", th=thresholds((None, "green"), (1, "red")), mappings=vmap([(0, "В порядке", "green")]),
       description="На скольких серверах с бэкапом конфигурации Veeam что-то не так: не делается, упал, устарел или без шифрования. На каких — в таблице «Серверы».")
o.stat("Репозитории", 21, y, 3, 4, [target(f"max({repo_pct('used')})", instant=True)], unit="percent", decimals=0,
       th=thresholds((None, "green"), (80, "orange"), (90, "red")), no_value="—",
       description="Насколько заполнен самый полный репозиторий. Жёлтый — от 80 %, красный — от 90 %.")
y += 4

o.table("Серверы — нажмите на сервер, чтобы смотреть только его", 0, y, 24, 7, [
    target(f"max by (server) (veeam_server_up{S})", "A", instant=True, fmt="table"),
    target(f"count by (server) {FAILED} or max by (server) (veeam_server_up{S}) * 0", "B", instant=True, fmt="table"),
    target(f"count by (server) {WARNED} or max by (server) (veeam_server_up{S}) * 0", "C", instant=True, fmt="table"),
    target(f"sum by (server) (veeam_job_running{S})", "D", instant=True, fmt="table"),
    target(f"count by (server) {ENABLED}", "E", instant=True, fmt="table"),
    target(CONFIG_CODE, "F", instant=True, fmt="table"),
    target(f"max by (server) ({repo_pct('used')})", "G", instant=True, fmt="table"),
], renames={"server": "Сервер", "Value #A": "Связь", "Value #B": "Упали", "Value #C": "Предупреждения", "Value #D": "Идут",
            "Value #E": "Заданий включено", "Value #F": "Бэкап конфигурации", "Value #G": "Макс. заполнение"},
   order=["server", "Value #A", "Value #B", "Value #C", "Value #D", "Value #E", "Value #F", "Value #G"],
   overrides=[
       override("server", ("links", SERVER_LINK), ("custom.width", 200)),
       override("Value #A", ("mappings", vmap([(1, "На связи", "green"), (0, "Нет связи", "red")])), ("custom.cellOptions", BACKGROUND),
                ("thresholds", thresholds((None, "red"), (1, "green")))),
       override("Value #B", ("custom.cellOptions", BACKGROUND), ("thresholds", thresholds((None, "transparent"), (1, "red")))),
       override("Value #C", ("custom.cellOptions", BACKGROUND), ("thresholds", thresholds((None, "transparent"), (1, "orange")))),
       override("Value #D", ("custom.cellOptions", {"type": "color-text"}), ("thresholds", thresholds((None, "text"), (1, "blue")))),
       override("Value #F", ("mappings", CONFIG_MAP), ("custom.cellOptions", BACKGROUND), ("thresholds", thresholds((None, "green"), (1, "orange"), (3, "red")))),
       override("Value #G", ("unit", "percent"), ("decimals", 0), ("min", 0), ("max", 100),
                ("thresholds", thresholds((None, "green"), (80, "orange"), (90, "red"))),
                ("custom.cellOptions", {"type": "gauge", "mode": "basic", "valueDisplayMode": "text"})),
   ],
   sort=[("Сервер", False)],
   description="Каждый сервер Veeam одной строкой: на связи ли он, сколько заданий упало и идёт, бэкап его конфигурации и самый заполненный репозиторий.")
y += 7

o.table("Что сломано сейчас — нажмите на задание, чтобы открыть подробности", 0, y, 24, 14, [
    target(f"{ATTENTION} + 0", "A", instant=True, fmt="table"),
    target(f"{hours_since(f'veeam_job_last_run_timestamp_seconds{S}')} and on (server, job_id) {ATTENTION}", "B", instant=True, fmt="table"),
    target(f'veeam_job_last_session_machines{sel(result="failed")} + 0 and on (server, job_id) {ATTENTION}', "C", instant=True, fmt="table"),
    target(f"veeam_job_last_session_message{S} and on (server, job_id) {ATTENTION}", "D", instant=True, fmt="table"),
    # Errors before warnings, and the newest first within each: Grafana sorts a table by one column.
    target(f"({ATTENTION} * 1e9 - (time() - veeam_job_last_run_timestamp_seconds{S})) or on (server, job_id) ({ATTENTION} * 1e9 - 1e8)",
           "E", instant=True, fmt="table"),
], renames={"server": "Сервер", "job_name": "Задание", "Value #A": "Итог", "Value #B": "Когда",
            "Value #C": "Машин с ошибкой", "message": "Что сказал Veeam"},
   order=["Value #A", "Value #B", "server", "job_name", "Value #C", "message"],
   hide=["job_type", "result", "Value #D"],
   overrides=[
       override("Value #A", ("mappings", RESULT_MAP), ("custom.cellOptions", BACKGROUND), ("thresholds", RESULT_COLORS), ("custom.width", 150)),
       override("Value #B", ("unit", AGO_UNIT), ("decimals", 0), ("mappings", AGO), ("custom.width", 210)),
       override("server", ("custom.width", 150)),
       override("job_name", ("links", JOB_LINK), ("custom.width", 330)),
       override("Value #C", ("custom.width", 170), ("custom.cellOptions", {"type": "color-text"}), ("thresholds", thresholds((None, "text"), (1, "red")))),
   ],
   sort_key="Value #E", no_value="Ничего не сломано",
   description="Включённые задания, чей последний запуск закончился ошибкой или предупреждением, — сначала ошибки, свежие сверху. "
               "«Что сказал Veeam» — сообщение последней сессии: машина и причина; целиком — на странице задания. Задание, которое сейчас идёт, сюда не попадает: Veeam очищает его результат до конца запуска.")
y += 14

o.table("Идут сейчас", 0, y, 24, 6, [
    target(f"veeam_job_session_progress_percent{S} + 0", "A", instant=True, fmt="table"),
    target(f"veeam_job_session_running_since_timestamp_seconds{S} * 1000", "B", instant=True, fmt="table"),
    target(f"time() - veeam_job_session_running_since_timestamp_seconds{S}", "C", instant=True, fmt="table"),
], renames={"server": "Сервер", "job_name": "Задание", "job_type": "Тип", "Value #A": "Прогресс", "Value #B": "Начато", "Value #C": "Идёт уже"},
   order=["server", "job_name", "job_type", "Value #A", "Value #B", "Value #C"],
   overrides=[
       override("job_name", ("links", JOB_LINK), ("custom.width", 330)),
       override("Value #A", ("unit", "percent"), ("min", 0), ("max", 100), ("decimals", 0),
                ("custom.cellOptions", {"type": "gauge", "mode": "gradient", "valueDisplayMode": "text"}), ("color", {"mode": "continuous-BlPu"})),
       override("Value #B", ("unit", "dateTimeAsLocal"), ("custom.width", 175)),
       override("Value #C", ("unit", "dtdhms"), ("custom.width", 110)),
       override("server", ("custom.width", 150)),
       override("job_type", ("custom.width", 160)),
   ],
   sort=[("Идёт уже", True)], no_value="Ничего не идёт",
   description="Сессии, которые Veeam выполняет сейчас, и как далеко они продвинулись. Обновляется раз в две минуты.")
y += 6

o.bars("Самые заполненные репозитории", 0, y, 12, 9, f"sort_desc(topk(10, {per_storage('used', 'max')}))", "{{repository}}",
       description="Десять самых полных хранилищ. Одно хранилище, подключённое к нескольким серверам Veeam, показано один раз. Жёлтый — от 80 %, красный — от 90 %.")
o.timeseries("Свободное место: как оно уходит", 12, y, 12, 9, [target(f"bottomk(10, {per_storage('free', 'min')})", legend="{{repository}}")],
             unit="percent", min_=0, max_=100, legend_calcs=["lastNotNull", "min"],
             description="Свободное место в процентах у десяти хранилищ, где его меньше всего. По наклону видно, как быстро оно уходит.")
y += 9

late = (f"(time() - veeam_job_last_run_timestamp_seconds{S}) / 86400 > 7"
        f" and on (server, job_id) veeam_job_next_run_timestamp_seconds{S}"
        f" and on (server, job_id) {ENABLED}")
o.table("В расписании, но не запускались больше недели", 0, y, 24, 6, [target(late, "A", instant=True, fmt="table")],
        renames={"server": "Сервер", "job_name": "Задание", "job_type": "Тип", "Value": "Дней без запуска"},
        order=["server", "job_name", "job_type", "Value"],
        overrides=[override("job_name", ("links", JOB_LINK)),
                   override("Value", ("decimals", 0), ("custom.cellOptions", {"type": "color-text"}), ("thresholds", thresholds((None, "orange"), (30, "red"))))],
        sort=[("Дней без запуска", True)], merge=False, no_value="Таких нет",
        description="Включённые задания, у которых есть следующий запуск по расписанию, но последний был больше недели назад. Ежемесячные задания попадают сюда законно.")
y += 6

o.timeseries("Упавшие задания по серверам", 0, y, 12, 8, [target(f"count by (server) {FAILED}", legend="{{server}}")],
             draw="bars", stack=True, decimals=0, description="Сколько заданий на каждом сервере стояло упавшими в каждый момент — так же, как плитка «Упали».")
o.timeseries("Идущие задания по серверам", 12, y, 12, 8, [target(f"sum by (server) (veeam_job_running{S})", legend="{{server}}")],
             draw="bars", stack=True, decimals=0, description="Сколько заданий выполнялось одновременно: видно окно бэкапа и где оно перегружено.")
y += 8

stuck = o.table("", 0, 0, 24, 12, [
    target(f"{STUCK} + 0", "A", instant=True, fmt="table"),
    target(f"veeam_job_last_run_timestamp_seconds{S} * 1000 and on (server, job_id) {STUCK}", "B", instant=True, fmt="table"),
], renames={"server": "Сервер", "job_name": "Задание", "job_type": "Тип", "Value #A": "Итог", "Value #B": "Последний запуск"},
   order=["Value #A", "Value #B", "server", "job_name", "job_type"],
   overrides=[
       override("Value #A", ("mappings", RESULT_MAP), ("custom.cellOptions", {"type": "color-text"}), ("thresholds", RESULT_COLORS), ("custom.width", 150)),
       override("Value #B", ("unit", "dateTimeAsLocal"), ("custom.width", 190)),
       override("job_name", ("links", JOB_LINK)),
   ],
   sort=[("Последний запуск", True)], no_value="Таких нет",
   description="Включённые задания, которые стоят в ошибке или предупреждении, но не запускались больше недели и не стоят в расписании: "
               "скорее всего, брошенные. Их стоит отключить или удалить в Veeam — или запустить, если они нужны.")
stuck["title"] = "Давно в ошибке: не запускались больше недели и не в расписании"
o.folded("Давно в ошибке — брошенные задания", y, stuck)
y += 1

all_jobs = o.table("", 0, 0, 24, 16, [
    target(f"veeam_job_last_result{S} + 0", "A", instant=True, fmt="table"),
    target(f"veeam_job_last_run_timestamp_seconds{S} * 1000", "B", instant=True, fmt="table"),
    target(f"veeam_job_last_session_duration_seconds{S} + 0", "C", instant=True, fmt="table"),
    target(f"veeam_job_last_session_transferred_bytes{S} + 0", "D", instant=True, fmt="table"),
    target(f"veeam_job_next_run_timestamp_seconds{S} * 1000", "E", instant=True, fmt="table"),
    target(f"veeam_job_objects{S} + 0", "F", instant=True, fmt="table"),
    target(f"veeam_job_disabled{S} + 0", "G", instant=True, fmt="table"),
], renames={"server": "Сервер", "job_name": "Задание", "job_type": "Тип", "Value #A": "Результат", "Value #B": "Последний запуск",
            "Value #C": "Длилось", "Value #D": "Передано", "Value #E": "Следующий запуск", "Value #F": "Машин", "Value #G": "Включено"},
   order=["server", "job_name", "job_type", "Value #G", "Value #A", "Value #B", "Value #C", "Value #D", "Value #E", "Value #F"],
   overrides=[
       override("job_name", ("links", JOB_LINK), ("custom.width", 300)),
       override("Value #G", ("mappings", vmap([(0, "Да", "text"), (1, "Отключено", "text")])), ("custom.width", 110)),
       override("Value #A", ("mappings", RESULT_MAP), ("custom.cellOptions", {"type": "color-text"}), ("custom.width", 140)),
       override("Value #B", ("unit", "dateTimeAsLocal"), ("custom.width", 175)),
       override("Value #C", ("unit", "dtdhms"), ("custom.width", 100)),
       override("Value #D", ("unit", "bytes"), ("decimals", 1), ("custom.width", 110)),
       override("Value #E", ("unit", "dateTimeAsLocal"), ("custom.width", 175)),
       override("Value #F", ("custom.width", 80)),
   ],
   sort=[("Задание", False)],
   description="Каждое задание выбранных серверов. Фильтр — значок у заголовка столбца; нажмите на задание, чтобы открыть подробности.")
all_jobs["title"] = "Все задания"
o.folded("Все задания", y, all_jobs)
y += 1

all_repos = o.table("", 0, 0, 24, 12, [
    target(f"veeam_repository_capacity_bytes{S} + 0", "A", instant=True, fmt="table"),
    target(f"veeam_repository_free_bytes{S} + 0", "B", instant=True, fmt="table"),
    target(repo_pct("used"), "C", instant=True, fmt="table"),
], renames={"server": "Сервер", "repository": "Репозиторий", "Value #A": "Ёмкость", "Value #B": "Свободно", "Value #C": "Занято"},
   order=["repository", "server", "Value #A", "Value #B", "Value #C"],
   overrides=[
       override("repository", ("custom.width", 380)),
       override("Value #A", ("unit", "bytes"), ("decimals", 1)),
       override("Value #B", ("unit", "bytes"), ("decimals", 1)),
       override("Value #C", ("unit", "percent"), ("decimals", 0), ("min", 0), ("max", 100),
                ("thresholds", thresholds((None, "green"), (80, "orange"), (90, "red"))),
                ("custom.cellOptions", {"type": "gauge", "mode": "basic", "valueDisplayMode": "text"})),
   ],
   sort=[("Занято", True)], description="Каждый репозиторий каждого сервера, как его сообщает Veeam: общее хранилище здесь стоит столько раз, сколько серверов его видят.")
all_repos["title"] = "Все репозитории по серверам"
o.folded("Все репозитории по серверам", y, all_repos)

overview = dashboard("veeam-overview", "Veeam — обзор",
                     "То, что бот прочитал у серверов Veeam: что сломано, что идёт, место на репозиториях, бэкап конфигурации.",
                     o.panels, [server_variable(True)], "now-24h",
                     [{"title": "Задание", "type": "link", "url": "/d/veeam-job/veeam-zadanie", "icon": "dashboard", "targetBlank": False,
                       "tooltip": "Подробности одного задания", "keepTime": True}])

# =============================================================================
# One job: how it ended and why, then how its machines ended, then its history.
# =============================================================================
j = Board()
y = 0
j.stat("Последний запуск", 0, y, 6, 5, [target(f"veeam_job_last_session_result{J}", instant=True)], mappings=RESULT_MAP,
       th=RESULT_COLORS, no_value="Нет данных", text={"valueSize": 44},
       description="Чем закончилась последняя завершённая сессия задания. Если Veeam повторял попытку, это последняя попытка. "
                   "«Нет данных» — задание не запускалось последний месяц.")
said = (f"veeam_job_last_session_message{J} or on (server, job_id) "
        f'label_replace(veeam_job_last_session_result{J}, "message", "Veeam не оставил сообщения о последнем запуске", "", "")')
j.table("Что сказал Veeam", 6, y, 18, 5, [target(said, "A", instant=True, fmt="table")],
        renames={"message": "Сообщение"}, order=["message"], hide=["server", "job_name", "job_type", "Value"],
        overrides=[override("message", ("custom.cellOptions", {"type": "auto", "wrapText": True}))], merge=False, no_value="Нет данных",
        description="Сообщение Veeam о последней сессии: машина и причина, без учётных данных. Когда всё прошло гладко, Veeam обычно ничего не пишет.")
y += 5

j.stat("Закончился", 0, y, 4, 4, [target(hours_since(f"veeam_job_last_session_end_timestamp_seconds{J}"), instant=True)],
       unit=AGO_UNIT, decimals=0, mappings=AGO, color_mode="none", no_value="—", text={"valueSize": 26},
       description="Когда закончилась последняя сессия. Точное время — в подсказке графиков ниже.")
j.stat("Длился", 4, y, 3, 4, [target(f"veeam_job_last_session_duration_seconds{J}", instant=True)], unit="dtdhms", color_mode="none", no_value="—",
       text={"valueSize": 26})
machine_colors = (("Успешно", "green"), ("Предупреждение", "orange"), ("Ошибка", "red"))
j.stat("Машины последнего запуска", 7, y, 7, 4, [
    target(f'sum(veeam_job_last_session_machines{job_sel(result=result)}) or sum(veeam_job_last_session_result{J}) * 0', ref, instant=True, legend=name)
    for ref, (result, (name, _)) in zip("ABC", zip(("success", "warning", "failed"), machine_colors))
], text_mode="value_and_name", color_mode="value", no_value="—", text={"titleSize": 14, "valueSize": 30}, orientation="vertical",
       overrides=[override(name, ("thresholds", thresholds((None, "text"), (1, color)))) for name, color in machine_colors],
       description="Сколько машин последней сессии закончилось успешно, с предупреждением и с ошибкой. Какие и почему — в таблице ниже.")
j.stat("Следующий запуск", 14, y, 4, 4, [target(f"veeam_job_next_run_timestamp_seconds{J} * 1000", instant=True)],
       unit="dateTimeAsLocalNoDateIfToday", color_mode="none", no_value="Не по расписанию", text={"valueSize": 22})
j.stat("Сейчас", 18, y, 3, 4, [target(f"veeam_job_session_progress_percent{J}", instant=True)], unit="percent", decimals=0,
       th=thresholds((None, "transparent"), (0, "blue")), no_value="Не идёт", text={"valueSize": 30},
       description="Если задание выполняется прямо сейчас — сколько процентов готово. Обновляется раз в две минуты.")
j.stat("Идёт уже", 21, y, 3, 4, [target(f"time() - veeam_job_session_running_since_timestamp_seconds{J}", instant=True)],
       unit="dtdhms", color_mode="none", no_value="—", text={"valueSize": 26})
y += 4

j.table("Машины последнего запуска — сначала те, что с ошибкой", 0, y, 24, 9,
        [target(f"veeam_job_last_session_machine_result{J}", "A", instant=True, fmt="table")],
        renames={"machine": "Машина", "Value": "Итог", "reason": "Причина"}, order=["Value", "machine", "reason"],
        hide=["server", "job_name", "job_type"],
        overrides=[override("Value", ("mappings", RESULT_MAP), ("custom.cellOptions", BACKGROUND), ("thresholds", RESULT_COLORS), ("custom.width", 160)),
                   override("machine", ("custom.width", 380)),
                   override("reason", ("custom.cellOptions", {"type": "auto", "wrapText": True}))],
        sort=[("Итог", True)], merge=False, no_value="Нет данных",
        description="Каждая машина последней сессии: чем закончилась и, если не успешно, почему — словами Veeam. "
                    "Сразу после перезапуска бота машины дочитываются несколько минут.")
y += 9

j.stat("Прочитано", 0, y, 6, 3, [target(f"veeam_job_last_session_read_bytes{J}", instant=True)], unit="bytes", decimals=1, color_mode="none", no_value="—",
       description="Сколько данных Veeam прочитал с дисков машин в последней сессии. Пустые и неизменённые блоки он пропускает.", text={"valueSize": 24})
j.stat("Передано", 6, y, 6, 3, [target(f"veeam_job_last_session_transferred_bytes{J}", instant=True)], unit="bytes", decimals=1, color_mode="none", no_value="—",
       description="Сколько ушло дальше, на репозиторий или на целевую площадку, после сжатия и дедупликации.", text={"valueSize": 24})
j.stat("Средняя скорость", 12, y, 6, 3,
       [target(f"veeam_job_last_session_read_bytes{J} / veeam_job_last_session_duration_seconds{J}", instant=True)],
       unit="binBps", decimals=0, color_mode="none", no_value="—", text={"valueSize": 24},
       description="Прочитанное, делённое на длительность сессии: средняя скорость за весь запуск.")
j.stat("Узкое место", 18, y, 6, 3, [target(f"veeam_job_last_session_bottleneck{J}", instant=True, legend="{{bottleneck}}")],
       text_mode="name", color_mode="none", no_value="—", text={"valueSize": 24},
       description="Этап, который сильнее всего тормозил машины задания: Source — чтение исходных дисков, Proxy — прокси, Network — сеть, Target — запись в репозиторий или на целевую площадку.")
y += 3

j.add({
    "id": j.pid(), "type": "state-timeline", "title": "Чем заканчивались запуски", "datasource": DS, "gridPos": {"x": 0, "y": y, "w": 24, "h": 4},
    "description": "Чем заканчивалась каждая сессия задания: цвет меняется, когда заканчивается следующая.",
    "targets": [target(f"veeam_job_last_session_result{J}", legend="Итог")],
    "fieldConfig": {"defaults": {"mappings": RESULT_MAP, "color": {"mode": "fixed", "fixedColor": "text"}, "thresholds": thresholds((None, "green")),
                                 "custom": {"lineWidth": 0, "fillOpacity": 80}}, "overrides": []},
    "options": {"mergeValues": True, "showValue": "auto", "alignValue": "left", "rowHeight": 0.9, "legend": {"showLegend": False, "displayMode": "list", "placement": "bottom"},
                "tooltip": {"mode": "single", "sort": "none"}},
})
y += 4
j.timeseries("Длительность запусков", 0, y, 12, 8, [target(f"veeam_job_last_session_duration_seconds{J} / 3600", legend="Длилось")],
             unit="suffix: ч", decimals=1, step=True, description="Сколько длилась каждая сессия. Ступенька — новая сессия.")
j.timeseries("Прочитано и передано", 12, y, 12, 8, [
    target(f"veeam_job_last_session_read_bytes{J}", "A", legend="Прочитано"),
    target(f"veeam_job_last_session_transferred_bytes{J}", "B", legend="Передано"),
], unit="bytes", step=True, description="Сколько прочитала и передала каждая сессия.")
y += 8
j.timeseries("Прогресс идущей сессии", 0, y, 12, 8, [target(f"veeam_job_session_progress_percent{J}", legend="Прогресс")],
             unit="percent", min_=0, max_=100, description="Как продвигалась сессия, пока шла. Если линия надолго замерла — сессия стоит.")
j.timeseries("Скорость запусков", 12, y, 12, 8,
             [target(f"veeam_job_last_session_read_bytes{J} / veeam_job_last_session_duration_seconds{J}", legend="Скорость")],
             unit="binBps", step=True, description="Средняя скорость каждой сессии: прочитанное, делённое на длительность.")

job_variable = {
    "name": "job", "label": "Задание", "type": "query", "datasource": DS,
    "query": {"query": 'label_values(veeam_job_last_result{server="$server"}, job_name)', "refId": "job"},
    "definition": 'label_values(veeam_job_last_result{server="$server"}, job_name)',
    "refresh": 2, "sort": 5, "multi": False, "includeAll": False, "current": {}, "options": [], "hide": 0, "skipUrlSync": False, "regex": "",
}
job_board = dashboard("veeam-job", "Veeam — задание",
                      "Одно задание: чем закончилось и почему, его машины с причинами, длительность и объёмы по запускам.",
                      j.panels, [server_variable(False), job_variable], "now-7d",
                      [{"title": "← Обзор", "type": "link", "url": OVERVIEW_URL, "icon": "dashboard", "targetBlank": False,
                        "tooltip": "Все серверы и задания", "keepTime": False}])

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "grafana", "dashboards")
for name, board in (("veeam-overview.json", overview), ("veeam-job.json", job_board)):
    with open(os.path.join(out, name), "w", encoding="utf-8") as f:
        json.dump(board, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(name, len(board["panels"]), "panels")
