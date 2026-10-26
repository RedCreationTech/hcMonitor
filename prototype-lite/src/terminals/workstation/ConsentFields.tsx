import { Checkbox, Form, Input, Space } from 'antd';
export const participants = (v: Record<string, unknown>) => ['interviewer', 'subject'].map(role => ({
  id: String(v[`${role}_id`]), role,
  purposes: { capture: true, analyze: true, review: !!v.review, report: !!v.report, training: false },
}));
export function ConsentFields() {
  return <>
    <Space align="start"><Form.Item name="interviewer_id" label="访谈员匿名编号" rules={[{ required: true }, { pattern: /^[A-Za-z0-9_-]+$/, message: '请使用字母、数字、横线' }]}><Input /></Form.Item>
      <Form.Item name="subject_id" label="受访者匿名编号" rules={[{ required: true }, { pattern: /^[A-Za-z0-9_-]+$/, message: '请使用字母、数字、横线' }]}><Input /></Form.Item></Space>
    <Form.Item name="capture_analyze" valuePropName="checked" rules={[{ validator: (_, value) => value ? Promise.resolve() : Promise.reject(new Error('请确认两人的采集及分析用途')) }]}><Checkbox>两名参与者均已授权采集及本次分析</Checkbox></Form.Item>
    <Form.Item name="review" valuePropName="checked"><Checkbox>两名参与者均已授权指定专家查看与复核</Checkbox></Form.Item>
    <Form.Item name="report" valuePropName="checked"><Checkbox>两名参与者均已授权报告编制与分发</Checkbox></Form.Item>
    <p className="sub">训练用途默认关闭；上述勾选须有告知文书支持。</p>
  </>;
}
