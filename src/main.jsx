import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CloudDownload, Download, FileText, Gauge, LineChart, Plus, RefreshCcw, Save, Settings, ShieldAlert, WalletCards } from 'lucide-react';
import dayjs from 'dayjs';
import 'antd/dist/reset.css';
import './styles.css';

const { Header, Content, Sider } = Layout;
const { Title, Text } = Typography;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    let detail = await response.text();
    try {
      detail = JSON.parse(detail).error || detail;
    } catch {}
    throw new Error(detail);
  }
  return response.json();
}

const riskColor = { 正常: 'green', 观察: 'gold', 防守: 'orange', 危险: 'red', 待记录: 'default' };
const sourceLabel = { tdx_local: '通达信本地', akshare: 'akshare', manual: '手动' };
const alertType = { danger: 'error', warning: 'warning', success: 'success', info: 'info' };

function money(value) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function pct(value) {
  if (value === null || value === undefined || value === '') return '-';
  return `${Number(value || 0).toFixed(2)}%`;
}

function App() {
  const { message, modal } = AntApp.useApp();
  const [active, setActive] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [indexes, setIndexes] = useState({ records: [], states: [], indexOptions: [] });
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [dash, idx, rev] = await Promise.all([api('/api/dashboard'), api('/api/indexes'), api('/api/reviews')]);
      setDashboard(dash);
      setIndexes(idx);
      setReviews(rev);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const updateMarket = async () => {
    setMarketLoading(true);
    try {
      const result = await api('/api/market/update', { method: 'POST', body: JSON.stringify({}) });
      await loadAll();
      const failures = [...result.stock.failures, ...result.index.failures];
      modal.info({
        title: failures.length ? '行情更新完成，有部分失败' : '行情更新完成',
        width: 920,
        content: <MarketUpdateResult result={result} />,
      });
    } catch (error) {
      modal.error({ title: '行情更新失败', content: error.message || '数据源异常，请稍后重试。' });
    } finally {
      setMarketLoading(false);
    }
  };

  const items = [
    { key: 'dashboard', icon: <Gauge size={18} />, label: '投资控制台' },
    { key: 'positions', icon: <WalletCards size={18} />, label: '持仓管理' },
    { key: 'rules', icon: <ShieldAlert size={18} />, label: '风控规则' },
    { key: 'indexes', icon: <LineChart size={18} />, label: '指数记录' },
    { key: 'reviews', icon: <FileText size={18} />, label: '每日复盘' },
    { key: 'settings', icon: <Settings size={18} />, label: '系统设置' },
  ];

  return (
    <Layout className="app-shell">
      <Sider width={220} className="side">
        <div className="brand">复盘仓位系统</div>
        <div className="nav-list">
          {items.map((item) => (
            <button key={item.key} className={`nav-item ${active === item.key ? 'active' : ''}`} onClick={() => setActive(item.key)}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </Sider>
      <Layout>
        <Header className="topbar">
          <div>
            <Title level={3}>{items.find((item) => item.key === active)?.label}</Title>
            <Text type="secondary">优先读取通达信本地日线，失败后可回退 akshare，最终保留手动录入兜底</Text>
          </div>
          <Space wrap>
            <Button icon={<Download size={16} />} href="/api/export/positions">导出持仓</Button>
            <Button icon={<Download size={16} />} href="/api/export/reviews">导出复盘</Button>
            <Button icon={<CloudDownload size={16} />} type="primary" ghost loading={marketLoading} onClick={updateMarket}>更新行情</Button>
            <Button type="primary" icon={<RefreshCcw size={16} />} loading={loading} onClick={loadAll}>刷新</Button>
          </Space>
        </Header>
        <Content className="content">
          {active === 'dashboard' && <Dashboard data={dashboard} indexes={indexes} marketLoading={marketLoading} onUpdateMarket={updateMarket} />}
          {active === 'positions' && <Positions data={dashboard} onChange={loadAll} />}
          {active === 'rules' && <Rules data={dashboard} onChange={loadAll} />}
          {active === 'indexes' && <Indexes data={indexes} onChange={loadAll} />}
          {active === 'reviews' && <Reviews reviews={reviews} onChange={loadAll} />}
          {active === 'settings' && <SystemSettings data={dashboard} onChange={loadAll} />}
        </Content>
      </Layout>
    </Layout>
  );
}

function MarketUpdateResult({ result }) {
  const rows = [
    ...(result.stock.results || []).map((item) => ({ ...item, type: '持仓股' })),
    ...(result.stock.failures || []).map((item) => ({ ...item, type: '持仓股', success: false })),
    ...(result.index.results || []).map((item) => ({ ...item, type: '指数', price: item.closePoint })),
    ...(result.index.failures || []).map((item) => ({ ...item, type: '指数', success: false })),
  ];
  return (
    <Space direction="vertical" className="full">
      <Alert
        showIcon
        type={result.stock.failed || result.index.failed ? 'warning' : 'success'}
        message={`持仓 ${result.stock.success}/${result.stock.requested} 成功，失败 ${result.stock.failed}；指数 ${result.index.success}/${result.index.requested} 成功，失败 ${result.index.failed}`}
      />
      <Table
        size="small"
        rowKey={(row, index) => `${row.type}-${row.code}-${index}`}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '类型', dataIndex: 'type', width: 90 },
          { title: '代码', dataIndex: 'code', width: 90 },
          { title: '名称', dataIndex: 'name', width: 120 },
          { title: '状态', dataIndex: 'success', width: 90, render: (v) => <Tag color={v ? 'green' : 'red'}>{v ? '成功' : '失败'}</Tag> },
          { title: '来源', dataIndex: 'source', width: 110, render: (v) => sourceLabel[v] || v || '-' },
          { title: '行情日期', dataIndex: 'tradeDate', width: 120, render: (v) => v || '-' },
          { title: '当天数据', dataIndex: 'isLatest', width: 100, render: (v) => <Tag color={v ? 'green' : 'gold'}>{v ? '是' : '否'}</Tag> },
          { title: '最新价/点位', dataIndex: 'price', align: 'right', width: 110, render: (v) => v ?? '-' },
          { title: '涨跌幅', dataIndex: 'changePct', align: 'right', width: 90, render: pct },
          { title: '失败原因', dataIndex: 'reason', ellipsis: true },
        ]}
      />
    </Space>
  );
}

function Dashboard({ data, indexes, marketLoading, onUpdateMarket }) {
  if (!data) return null;
  const stats = data.account;
  return (
    <Space direction="vertical" size={18} className="full">
      <Card className="section-card">
        <Space wrap className="spread">
          <Text>点击后优先读取通达信本地日线；本地缺失或未更新时，按设置回退 akshare。</Text>
          <Button type="primary" icon={<CloudDownload size={16} />} loading={marketLoading} onClick={onUpdateMarket}>更新行情</Button>
        </Space>
      </Card>
      <Row gutter={[16, 16]}>
        <Metric title="总资产" value={money(stats.totalEquity)} prefix="¥" />
        <Metric title="现金" value={money(stats.cash)} prefix="¥" />
        <Metric title="现金比例" value={pct(stats.cashRatio)} />
        <Metric title="持仓市值" value={money(stats.holdingValue)} prefix="¥" />
        <Metric title="总仓位" value={pct(stats.positionRatio)} />
        <Metric title="今年收益率" value={pct(stats.yearReturn)} valueClass={stats.yearReturn >= 0 ? 'gain' : 'loss'} />
        <Metric title="历史最高权益" value={money(stats.historicalHighEquity)} prefix="¥" />
        <Metric title="当前回撤" value={pct(stats.drawdown)} valueClass={stats.drawdown > 10 ? 'loss' : ''} />
        <Col xs={24} md={6}>
          <Card className="metric-card">
            <Text type="secondary">风险状态</Text>
            <div className="risk-line"><Tag color={riskColor[stats.riskStatus]}>{stats.riskStatus}</Tag></div>
          </Card>
        </Col>
      </Row>
      <Card title="今日风控提醒" className="section-card">
        {data.alerts.length === 0 ? <Empty description="暂无触发项" /> : (
          <Space direction="vertical" className="full">
            {data.alerts.map((item, index) => <Alert key={`${item.message}-${index}`} type={alertType[item.level]} message={`${item.scope}：${item.message}`} showIcon />)}
          </Space>
        )}
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}><PositionMiniTable positions={data.positions} /></Col>
        <Col xs={24} lg={10}>
          <Card title="市场状态" className="section-card">
            <Space direction="vertical" className="full">
              {indexes.states.map((item) => (
                <div className="market-row" key={item.indexCode}>
                  <span>{item.indexName}</span>
                  <Text type="secondary">{item.closePoint || '-'}</Text>
                  <Tag color={riskColor[item.state]}>{item.state}</Tag>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function PositionMiniTable({ positions }) {
  return (
    <Card title="持仓仓位" className="section-card">
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={positions}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '当前价', dataIndex: 'currentPrice', align: 'right' },
          { title: '来源', dataIndex: 'quoteSource', render: (v) => <Tag>{sourceLabel[v] || v || '-'}</Tag> },
          { title: '日期', dataIndex: 'quoteDate', render: (v, r) => v ? <Tag color={r.quoteIsLatest ? 'green' : 'gold'}>{v}</Tag> : '-' },
          { title: '涨跌幅', dataIndex: 'changePct', align: 'right', render: (v) => <span className={Number(v) >= 0 ? 'gain' : 'loss'}>{pct(v)}</span> },
          { title: '浮盈亏', dataIndex: 'profit', align: 'right', render: (v) => <span className={v >= 0 ? 'gain' : 'loss'}>{money(v)}</span> },
          { title: '仓位', dataIndex: 'positionRatio', align: 'right', render: (v) => <Progress percent={Number(v)} size="small" strokeColor={v > 20 ? '#d4380d' : '#1677ff'} /> },
        ]}
      />
    </Card>
  );
}

function Metric({ title, value, prefix, valueClass }) {
  return (
    <Col xs={24} sm={12} md={6}>
      <Card className="metric-card">
        <Statistic title={title} value={value} prefix={prefix} valueStyle={{ fontSize: 26 }} className={valueClass} />
      </Card>
    </Col>
  );
}

function Positions({ data, onChange }) {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const submit = async () => {
    const values = await form.validateFields();
    if (editing) await api(`/api/positions/${editing.id}`, { method: 'PUT', body: JSON.stringify(values) });
    else await api('/api/positions', { method: 'POST', body: JSON.stringify(values) });
    message.success('持仓已保存');
    setOpen(false);
    setEditing(null);
    form.resetFields();
    onChange();
  };

  const remove = async (id) => {
    await api(`/api/positions/${id}`, { method: 'DELETE' });
    message.success('持仓已删除');
    onChange();
  };

  return (
    <Card className="section-card" title="持仓列表" extra={<Button type="primary" icon={<Plus size={16} />} onClick={() => { form.resetFields(); setEditing(null); setOpen(true); }}>新增持仓</Button>}>
      <Table
        rowKey="id"
        dataSource={data?.positions || []}
        scroll={{ x: 1700 }}
        columns={[
          { title: '代码', dataIndex: 'code', fixed: 'left', width: 100 },
          { title: '名称', dataIndex: 'name', fixed: 'left', width: 110 },
          { title: '市场', dataIndex: 'market', width: 80 },
          { title: '行业', dataIndex: 'industry', width: 100 },
          { title: '类型', dataIndex: 'holdingType', width: 120, render: (v) => <Tag>{v}</Tag> },
          { title: '成本价', dataIndex: 'costPrice', align: 'right', width: 90 },
          { title: '数量', dataIndex: 'quantity', align: 'right', width: 90 },
          { title: '当前价', dataIndex: 'currentPrice', align: 'right', width: 90 },
          { title: '涨跌幅', dataIndex: 'changePct', align: 'right', width: 90, render: (v) => <span className={Number(v) >= 0 ? 'gain' : 'loss'}>{pct(v)}</span> },
          { title: '成交量', dataIndex: 'volume', align: 'right', width: 120, render: (v) => v === null || v === undefined ? '-' : money(v) },
          { title: '成交额', dataIndex: 'turnover', align: 'right', width: 120, render: (v) => v === null || v === undefined ? '-' : money(v) },
          { title: '行情日期', dataIndex: 'quoteDate', width: 120, render: (v, r) => v ? <Tag color={r.quoteIsLatest ? 'green' : 'gold'}>{v}</Tag> : '-' },
          { title: '来源', dataIndex: 'quoteSource', width: 110, render: (v) => <Tag>{sourceLabel[v] || v || '-'}</Tag> },
          { title: '市值', dataIndex: 'marketValue', align: 'right', width: 120, render: money },
          { title: '浮盈亏', dataIndex: 'profit', align: 'right', width: 110, render: (v) => <span className={v >= 0 ? 'gain' : 'loss'}>{money(v)}</span> },
          { title: '收益率', dataIndex: 'profitPct', align: 'right', width: 90, render: pct },
          { title: '仓位', dataIndex: 'positionRatio', align: 'right', width: 90, render: pct },
          { title: '操作', width: 140, fixed: 'right', render: (_, record) => <Space><Button size="small" onClick={() => { setEditing(record); form.setFieldsValue(record); setOpen(true); }}>编辑</Button><Popconfirm title="删除这条持仓？" onConfirm={() => remove(record.id)}><Button size="small" danger>删除</Button></Popconfirm></Space> },
        ]}
      />
      <Drawer title={editing ? '编辑持仓' : '新增持仓'} width={520} open={open} onClose={() => setOpen(false)} extra={<Button type="primary" icon={<Save size={16} />} onClick={submit}>保存</Button>}>
        <PositionForm form={form} />
      </Drawer>
    </Card>
  );
}

function PositionForm({ form }) {
  return (
    <Form form={form} layout="vertical" initialValues={{ holdingType: '观察仓', market: 'A股' }}>
      <Row gutter={12}>
        <Col span={12}><Form.Item name="code" label="股票代码" rules={[{ required: true }]}><Input placeholder="600000" /></Form.Item></Col>
        <Col span={12}><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item></Col>
        <Col span={12}><Form.Item name="market" label="市场"><Input /></Form.Item></Col>
        <Col span={12}><Form.Item name="industry" label="所属行业"><Input /></Form.Item></Col>
        <Col span={24}><Form.Item name="holdingType" label="持仓类型"><Select options={['防守仓', '稳定成长仓', '进攻仓', '观察仓'].map((value) => ({ value, label: value }))} /></Form.Item></Col>
        <Col span={8}><Form.Item name="costPrice" label="成本价" rules={[{ required: true }]}><InputNumber min={0} className="full" /></Form.Item></Col>
        <Col span={8}><Form.Item name="quantity" label="数量" rules={[{ required: true }]}><InputNumber min={0} precision={0} className="full" /></Form.Item></Col>
        <Col span={8}><Form.Item name="currentPrice" label="当前价" rules={[{ required: true }]}><InputNumber min={0} className="full" /></Form.Item></Col>
        <Col span={12}><Form.Item name="stopLossPrice" label="止损价"><InputNumber min={0} className="full" /></Form.Item></Col>
        <Col span={12}><Form.Item name="takeProfitPrice" label="止盈价"><InputNumber min={0} className="full" /></Form.Item></Col>
        <Col span={12}><Form.Item name="reduceBelowPrice" label="跌破减仓价"><InputNumber min={0} className="full" /></Form.Item></Col>
        <Col span={12}><Form.Item name="reduceRatio" label="减仓比例 %"><InputNumber min={0} max={100} className="full" /></Form.Item></Col>
        <Col span={24}><Form.Item name="observeAbovePrice" label="突破观察价"><InputNumber min={0} className="full" /></Form.Item></Col>
      </Row>
    </Form>
  );
}

function Rules({ data, onChange }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  useEffect(() => { if (data?.rules) form.setFieldsValue(data.rules); }, [data, form]);
  const submit = async () => {
    const values = await form.validateFields();
    await api('/api/rules', { method: 'PUT', body: JSON.stringify(values) });
    message.success('风控规则已保存');
    onChange();
  };
  return (
    <Card title="风控规则设置" className="section-card" extra={<Button type="primary" icon={<Save size={16} />} onClick={submit}>保存规则</Button>}>
      <Form form={form} layout="vertical">
        <Title level={5}>账户级规则</Title>
        <Row gutter={16}>
          <Col xs={24} md={8}><Form.Item name={['account', 'cash']} label="当前现金"><InputNumber min={0} className="full" /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name={['account', 'yearStartEquity']} label="年初权益"><InputNumber min={0} className="full" /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name={['account', 'historicalHighEquity']} label="账户历史最高权益"><InputNumber min={0} className="full" /></Form.Item></Col>
          <Col xs={24} md={6}><Form.Item name={['account', 'maxPositionRatio']} label="最大总仓位 %"><InputNumber min={0} max={100} className="full" /></Form.Item></Col>
          <Col xs={24} md={6}><Form.Item name={['account', 'minCashRatio']} label="最低现金比例 %"><InputNumber min={0} max={100} className="full" /></Form.Item></Col>
          <Col xs={24} md={6}><Form.Item name={['account', 'maxDrawdown']} label="最大回撤 %"><InputNumber min={0} max={100} className="full" /></Form.Item></Col>
          <Col xs={24} md={6}><Form.Item name={['account', 'annualProfitProtectLine']} label="年度收益保护线 %"><InputNumber className="full" /></Form.Item></Col>
        </Row>
        <Divider />
        <Title level={5}>个股与行业规则</Title>
        <Row gutter={16}>
          <Col xs={24} md={12}><Form.Item name={['stock', 'maxSinglePositionRatio']} label="单股最大仓位 %"><InputNumber min={0} max={100} className="full" /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name={['industry', 'maxIndustryPositionRatio']} label="单一行业最大仓位 %"><InputNumber min={0} max={100} className="full" /></Form.Item></Col>
        </Row>
      </Form>
    </Card>
  );
}

function SystemSettings({ data, onChange }) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  useEffect(() => { if (data?.marketSettings) form.setFieldsValue(data.marketSettings); }, [data, form]);
  const save = async () => {
    const values = await form.validateFields();
    await api('/api/market/settings', { method: 'PUT', body: JSON.stringify(values) });
    message.success('行情设置已保存');
    onChange();
  };
  const detect = async () => {
    const values = await form.validateFields();
    const result = await api('/api/market/tdx-detect', { method: 'POST', body: JSON.stringify({ tdxPath: values.tdxPath }) });
    modal.info({
      title: result.ok ? '通达信目录检测通过' : '通达信目录检测发现问题',
      width: 760,
      content: <TdxDetectResult result={result} />,
    });
  };
  return (
    <Card title="行情数据源设置" className="section-card" extra={<Space><Button onClick={detect}>检测通达信数据目录</Button><Button type="primary" icon={<Save size={16} />} onClick={save}>保存设置</Button></Space>}>
      <Form form={form} layout="vertical" initialValues={{ tdxPath: 'D:\\HTZQ', preferTdxLocal: true, fallbackAkshare: true }}>
        <Form.Item name="tdxPath" label="通达信安装目录" rules={[{ required: true }]}><Input /></Form.Item>
        <Row gutter={16}>
          <Col xs={24} md={12}><Form.Item name="preferTdxLocal" label="优先使用通达信本地行情" valuePropName="checked"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="fallbackAkshare" label="本地失败后使用 akshare 备用" valuePropName="checked"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item></Col>
        </Row>
      </Form>
      <Alert showIcon type="info" message="当前阶段优先完成持仓股日线读取；指数自动更新仍保留原 akshare 路径，后续可继续扩展通达信指数文件。" />
    </Card>
  );
}

function TdxDetectResult({ result }) {
  return (
    <Space direction="vertical" className="full">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="安装目录">{result.tdxPath}</Descriptions.Item>
        <Descriptions.Item label="可读取 day 文件">{result.canReadDayFile ? '是' : '否'}</Descriptions.Item>
        <Descriptions.Item label="最近数据日期">{result.latestTradeDate || '-'}</Descriptions.Item>
        <Descriptions.Item label="参考交易日">{result.expectedDate}</Descriptions.Item>
        <Descriptions.Item label="是否最新">{result.isLatest ? '是' : '否'}</Descriptions.Item>
      </Descriptions>
      <Table size="small" pagination={false} rowKey="key" dataSource={result.checks} columns={[
        { title: '检查项', dataIndex: 'label' },
        { title: '路径', dataIndex: 'path' },
        { title: '结果', dataIndex: 'exists', width: 90, render: (v) => <Tag color={v ? 'green' : 'red'}>{v ? '存在' : '缺失'}</Tag> },
      ]} />
      {result.errors?.length ? <Alert type="warning" showIcon message="问题" description={result.errors.join('；')} /> : <Alert type="success" showIcon message="目录和样例 day 文件读取正常" />}
    </Space>
  );
}

function Indexes({ data, onChange }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const add = async () => {
    const values = await form.validateFields();
    const option = data.indexOptions.find((item) => item.indexCode === values.indexCode);
    await api('/api/indexes', { method: 'POST', body: JSON.stringify({ ...values, tradeDate: values.tradeDate.format('YYYY-MM-DD'), indexName: option?.indexName || values.indexCode }) });
    message.success('指数记录已保存');
    form.resetFields();
    onChange();
  };
  return (
    <Space direction="vertical" size={16} className="full">
      <Row gutter={[16, 16]}>
        {data.states.map((item) => (
          <Col xs={24} md={8} key={item.indexCode}>
            <Card className="metric-card">
              <Space direction="vertical" className="full">
                <Space className="spread"><b>{item.indexName}</b><Tag color={riskColor[item.state]}>{item.state}</Tag></Space>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="最新点位">{item.closePoint || '-'}</Descriptions.Item>
                  <Descriptions.Item label="20日均线">{item.ma20 || '-'}</Descriptions.Item>
                  <Descriptions.Item label="60日均线">{item.ma60 || '-'}</Descriptions.Item>
                  <Descriptions.Item label="20日线以上">{item.aboveMa20 ? '是' : '否'}</Descriptions.Item>
                  <Descriptions.Item label="60日线以上">{item.aboveMa60 ? '是' : '否'}</Descriptions.Item>
                </Descriptions>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
      <Card title="新增指数记录" className="section-card" extra={<Button type="primary" icon={<Plus size={16} />} onClick={add}>保存记录</Button>}>
        <Form form={form} layout="vertical" initialValues={{ tradeDate: dayjs(), indexCode: '000001.SH' }}>
          <Row gutter={16}>
            <Col xs={24} md={5}><Form.Item name="tradeDate" label="日期" rules={[{ required: true }]}><DatePicker className="full" /></Form.Item></Col>
            <Col xs={24} md={5}><Form.Item name="indexCode" label="指数" rules={[{ required: true }]}><Select options={data.indexOptions.map((item) => ({ value: item.indexCode, label: `${item.indexName} ${item.indexCode}` }))} /></Form.Item></Col>
            <Col xs={24} md={4}><Form.Item name="closePoint" label="收盘点位" rules={[{ required: true }]}><InputNumber min={0} className="full" /></Form.Item></Col>
            <Col xs={24} md={4}><Form.Item name="changePct" label="涨跌幅 %"><InputNumber className="full" /></Form.Item></Col>
            <Col xs={24} md={6}><Form.Item name="turnover" label="成交额"><InputNumber min={0} className="full" /></Form.Item></Col>
          </Row>
        </Form>
      </Card>
      <Card title="历史记录" className="section-card">
        <Table rowKey="id" dataSource={data.records} columns={[
          { title: '日期', dataIndex: 'tradeDate' },
          { title: '指数', dataIndex: 'indexName' },
          { title: '开盘', dataIndex: 'openPoint', align: 'right', render: (v) => v ?? '-' },
          { title: '最高', dataIndex: 'highPoint', align: 'right', render: (v) => v ?? '-' },
          { title: '最低', dataIndex: 'lowPoint', align: 'right', render: (v) => v ?? '-' },
          { title: '收盘点位', dataIndex: 'closePoint', align: 'right' },
          { title: '涨跌幅', dataIndex: 'changePct', align: 'right', render: pct },
          { title: '成交量', dataIndex: 'volume', align: 'right', render: (v) => v === null || v === undefined ? '-' : money(v) },
          { title: '成交额', dataIndex: 'turnover', align: 'right', render: money },
          { title: '来源', dataIndex: 'quoteSource', render: (v) => <Tag>{sourceLabel[v] || v || '-'}</Tag> },
          { title: '更新时间', dataIndex: 'quoteUpdatedAt', render: (v) => v || '-' },
        ]} />
      </Card>
    </Space>
  );
}

function Reviews({ reviews, onChange }) {
  const { message } = AntApp.useApp();
  const [date, setDate] = useState(dayjs());
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const generate = async () => {
    await api('/api/reviews/generate', { method: 'POST', body: JSON.stringify({ reviewDate: date.format('YYYY-MM-DD') }) });
    message.success('复盘记录已生成');
    onChange();
  };
  const save = async () => {
    const values = await form.validateFields();
    await api(`/api/reviews/${editing.id}`, { method: 'PUT', body: JSON.stringify(values) });
    message.success('复盘已保存');
    setEditing(null);
    onChange();
  };
  return (
    <Space direction="vertical" size={16} className="full">
      <Card className="section-card"><Space><DatePicker value={date} onChange={setDate} /><Button type="primary" icon={<Plus size={16} />} onClick={generate}>生成当日复盘</Button></Space></Card>
      <Card title="复盘历史" className="section-card">
        <Table rowKey="id" dataSource={reviews} columns={[
          { title: '日期', dataIndex: 'reviewDate', width: 120 },
          { title: '总资产', render: (_, r) => money(r.snapshot?.account?.totalEquity), align: 'right' },
          { title: '仓位', render: (_, r) => pct(r.snapshot?.account?.positionRatio), align: 'right' },
          { title: '风险', render: (_, r) => <Tag color={riskColor[r.snapshot?.account?.riskStatus]}>{r.snapshot?.account?.riskStatus}</Tag> },
          { title: '纪律', dataIndex: 'disciplineFollowed', render: (v) => <Tag color={v ? 'green' : 'red'}>{v ? '遵守' : '未遵守'}</Tag> },
          { title: '今日判断', dataIndex: 'judgement', ellipsis: true },
          { title: '操作', width: 100, render: (_, record) => <Button size="small" onClick={() => { setEditing(record); form.setFieldsValue(record); }}>填写</Button> },
        ]} />
      </Card>
      <Modal width={760} title="填写复盘" open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={save} okText="保存">
        <Form form={form} layout="vertical">
          <Form.Item name="judgement" label="今日判断"><Input.TextArea rows={4} /></Form.Item>
          <Form.Item name="tomorrowPlan" label="明日计划"><Input.TextArea rows={4} /></Form.Item>
          <Form.Item name="emotion" label="情绪状态"><Input /></Form.Item>
          <Form.Item name="disciplineFollowed" label="是否遵守纪律" valuePropName="checked"><Switch checkedChildren="是" unCheckedChildren="否" /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function Root() {
  return <AntApp><App /></AntApp>;
}

createRoot(document.getElementById('root')).render(<Root />);
