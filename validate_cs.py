import json

with open('data/items.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

items = data['items']
print(f'Total items: {len(items)}')

cs_items = [i for i in items if i.get('section') == 'cs']
print(f'CS items: {len(cs_items)}')
for i in cs_items:
    print(f'  {i["id"]}: {i["name"]}')