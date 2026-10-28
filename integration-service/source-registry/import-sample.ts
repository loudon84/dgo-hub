import { createHash } from 'node:crypto';
import type { SourceEntity } from '../auth/types.js';
import { parseStrictJson, validateHubBatch, type PublicBatch } from '../ingestion-api/strict-contract.js';
import type { FieldMapping } from './service.js';

export function mapImportSample(text: string, entity: SourceEntity, sourceId: string, mappings: readonly FieldMapping[]): PublicBatch {
  const input=parseStrictJson(Buffer.from(text,'utf8')) as Record<string,unknown>;
  if (!input || typeof input!=='object' || !Array.isArray(input.records)) throw new Error('INVALID_SAMPLE');
  const selected=mappings.filter(m=>m.entity===entity);
  const transform=(value:unknown, mapping:FieldMapping):unknown=> {
    if (mapping.transform==='trim') { if(typeof value!=='string') throw new Error('INVALID_MAPPING'); return value.trim(); }
    if (mapping.transform==='decimal-string' || mapping.transform==='source-id') { if(typeof value!=='string') throw new Error('INVALID_MAPPING'); }
    return value;
  };
  const records=input.records.map((raw:unknown)=>{
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('INVALID_SAMPLE');
    const record=raw as Record<string,unknown>;
    if(record.operation==='DELETE') return record;
    if(!record.data || typeof record.data!=='object' || Array.isArray(record.data)) throw new Error('INVALID_SAMPLE');
    const data=record.data as Record<string,unknown>, output:Record<string,unknown>={};
    const lineMappings=selected.filter(m=>m.target_field.startsWith('lines.'));
    for(const mapping of selected.filter(m=>!m.target_field.startsWith('lines.'))) {
      if(mapping.source_field.includes('.') || !Object.hasOwn(data,mapping.source_field)) throw new Error('INVALID_MAPPING');
      const value=transform(data[mapping.source_field],mapping);
      const target=mapping.target_field==='owner_user_id'?'owner_external_id':mapping.target_field==='dept_id'?'department_external_id':mapping.target_field;
      output[target]=target==='customer_id'?undefined:value;
      if(target==='customer_id') { delete output.customer_id; output.customer_ref=typeof value==='string'?{source_id:sourceId,source_pk:value}:value; }
    }
    if(entity==='order') {
      if(!Array.isArray(data.lines)) throw new Error('INVALID_MAPPING');
      output.lines=data.lines.map((line:unknown)=>{
        if(!line || typeof line!=='object' || Array.isArray(line)) throw new Error('INVALID_MAPPING');
        const mapped:Record<string,unknown>={};
        for(const m of lineMappings) {
          if(!/^lines\.[A-Za-z_][A-Za-z0-9_]*$/.test(m.source_field)) throw new Error('INVALID_MAPPING');
          const field=m.source_field.slice(6), value=line as Record<string,unknown>;
          if(!Object.hasOwn(value,field)) throw new Error('INVALID_MAPPING');
          mapped[m.target_field.slice(6)]=transform(value[field],m);
        }
        return mapped;
      });
    }
    return {...record,data:output};
  });
  return validateHubBatch({...input,records},entity);
}
export function importSamplesDigest(samples: Record<string,string>): Buffer {
  const hash=createHash('sha256');
  for(const key of Object.keys(samples).sort()) {
    const name=Buffer.from(key,'utf8'), data=Buffer.from(samples[key]!, 'utf8');
    hash.update(`${name.length}:`).update(name).update(`${data.length}:`).update(data);
  }
  return hash.digest();
}

export function customerReferenceMappingKey(sourceId:string,sourcePk:string):string {
  return 'c:'+createHash('sha256').update(JSON.stringify([sourceId,sourcePk]),'utf8').digest('base64url');
}
