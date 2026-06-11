import json
import math
import sys
from datetime import datetime

INDEX_CODES = {
    "000001": "上证指数",
    "399001": "深证成指",
    "399006": "创业板指",
    "000688": "科创50",
    "000300": "沪深300",
    "000905": "中证500",
}


def clean_code(code):
    digits = "".join(ch for ch in str(code or "") if ch.isdigit())
    return digits[-6:].zfill(6) if digits else ""


def safe_number(value):
    if value is None:
        return None
    try:
        if isinstance(value, str):
            value = value.replace(",", "").replace("%", "").strip()
            if value in {"", "-", "--", "None", "nan"}:
                return None
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    except Exception:
        return None


def first(row, names):
    for name in names:
        if name in row:
            return row.get(name)
    return None


def dataframe_rows(df):
    if df is None:
        return []
    return df.to_dict(orient="records")


def get_stock_quotes(ak, codes):
    requested = {clean_code(code) for code in codes if clean_code(code)}
    if not requested:
        return [], []
    try:
        df = ak.stock_zh_a_spot_em()
    except Exception as exc:
        return [], [{"code": code, "reason": f"akshare A股行情接口失败: {exc}"} for code in sorted(requested)]

    rows = dataframe_rows(df)
    by_code = {}
    for row in rows:
        code = clean_code(first(row, ["代码", "code", "证券代码"]))
        if code:
            by_code[code] = row

    quotes = []
    failures = []
    for code in sorted(requested):
        row = by_code.get(code)
        if not row:
            failures.append({"code": code, "reason": "未在 A股行情列表中找到"})
            continue
        price = safe_number(first(row, ["最新价", "收盘", "close", "最新"]))
        if price is None:
            failures.append({"code": code, "reason": "最新价为空"})
            continue
        quotes.append(
            {
                "code": code,
                "name": first(row, ["名称", "name", "证券简称"]) or "",
                "price": price,
                "changePct": safe_number(first(row, ["涨跌幅", "change_pct", "涨幅"])),
                "turnover": safe_number(first(row, ["成交额", "turnover", "成交额(元)"])),
            }
        )
    return quotes, failures


def get_index_quotes(ak):
    try:
        df = ak.stock_zh_index_spot_em()
    except Exception as exc:
        return [], [{"code": code, "name": name, "reason": f"akshare 指数行情接口失败: {exc}"} for code, name in INDEX_CODES.items()]

    rows = dataframe_rows(df)
    by_code = {}
    for row in rows:
        code = clean_code(first(row, ["代码", "code", "指数代码"]))
        if code:
            by_code[code] = row

    quotes = []
    failures = []
    for code, name in INDEX_CODES.items():
        row = by_code.get(code)
        if not row:
            failures.append({"code": code, "name": name, "reason": "未在指数行情列表中找到"})
            continue
        price = safe_number(first(row, ["最新价", "收盘", "close", "最新"]))
        if price is None:
            failures.append({"code": code, "name": name, "reason": "收盘点位为空"})
            continue
        quotes.append(
            {
                "code": code,
                "name": name,
                "price": price,
                "changePct": safe_number(first(row, ["涨跌幅", "change_pct", "涨幅"])),
                "turnover": safe_number(first(row, ["成交额", "turnover", "成交额(元)"])),
            }
        )
    return quotes, failures


def main():
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    codes = payload.get("codes", [])
    try:
        import akshare as ak
    except Exception as exc:
        result = {
            "ok": False,
            "tradeDate": datetime.now().strftime("%Y-%m-%d"),
            "updatedAt": datetime.now().isoformat(timespec="seconds"),
            "stocks": [],
            "indexes": [],
            "stockFailures": [{"code": clean_code(code), "reason": f"akshare 未安装或无法导入: {exc}"} for code in codes],
            "indexFailures": [{"code": code, "name": name, "reason": f"akshare 未安装或无法导入: {exc}"} for code, name in INDEX_CODES.items()],
        }
        print(json.dumps(result, ensure_ascii=False))
        return

    stocks, stock_failures = get_stock_quotes(ak, codes)
    indexes, index_failures = get_index_quotes(ak)
    result = {
        "ok": not stock_failures and not index_failures,
        "tradeDate": datetime.now().strftime("%Y-%m-%d"),
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "stocks": stocks,
        "indexes": indexes,
        "stockFailures": stock_failures,
        "indexFailures": index_failures,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
