import { describe, expect, it } from 'vitest';
import { mapImportSample } from './import-sample.js';
import type { FieldMapping } from './service.js';
const mappings:FieldMapping[]=[
  {entity:'order',source_field:'buyer',target_field:'customer_id',transform:'source-id'},
  {entity:'order',source_field:'number',target_field:'order_no',transform:'trim'},
  {entity:'order',source_field:'state',target_field:'status',transform:'identity'},
  {entity:'order',source_field:'at',target_field:'order_at',transform:'identity'},
  {entity:'order',source_field:'total',target_field:'amount',transform:'decimal-string'},
  {entity:'order',source_field:'ccy',target_field:'currency',transform:'identity'},
  ...(['source_line_id','product_code','product_name','quantity','unit_price','line_amount'] as const).map(field=>({entity:'order' as const,source_field:`lines.${field}`,target_field:`lines.${field}`,transform:(['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity') as FieldMapping['transform']})),
];
const sample=(data:unknown)=>JSON.stringify({schema_version:'hub.v1',batch_id:'10000000-0000-4000-8000-000000000001',records:[{event_id:'10000000-0000-4000-8000-000000000002',source_pk:'o1',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data}]});
const order={buyer:'c1',number:' O-1 ',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]};
describe('import sample mapping',()=>{
 it('maps source fields and full lines into the strict public order contract',()=>{
   const result=mapImportSample(sample(order),'order','import-one',mappings);
   expect(result.records[0].data).toMatchObject({customer_ref:{source_id:'import-one',source_pk:'c1'},order_no:'O-1',amount:'12.00',lines:[{source_line_id:'l1',quantity:'1.000000',line_amount:'12.00'}]});
 });
 it('rejects missing line mapping, malformed decimals and duplicate JSON keys',()=>{
   expect(()=>mapImportSample(sample(order),'order','import-one',mappings.slice(0,-1))).toThrow();
   expect(()=>mapImportSample(sample({...order,total:'12.999'}),'order','import-one',mappings)).toThrow();
   expect(()=>mapImportSample('{"schema_version":"hub.v1","schema_version":"hub.v1"}','order','import-one',mappings)).toThrow();
 });
 it('preserves explicit customer references without inferring a source',()=>{
   const explicit={...order,buyer:{source_id:'foreign-source',source_pk:'external-key'}};
   const explicitMappings=mappings.map(m=>m.target_field==='customer_id'?{...m,transform:'identity' as const}:m);
   const result=mapImportSample(sample(explicit),'order','import-one',explicitMappings);
   expect(result.records[0].data).toMatchObject({customer_ref:{source_id:'foreign-source',source_pk:'external-key'}});
 });

});
