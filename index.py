import requests

text = "hello"
lang = "en"
target = "ja"

url = "https://script.google.com/macros/s/AKfycbxPh_IjkSYpkfxHoGXVzK4oNQ2Vy0uRByGeNGA6ti3M7flAMCYkeJKuoBrALNCMImEi_g/exec"
#このGoogle App Scriptは koukun_ が運営している翻訳サービスです。大規模な翻訳を行えるように最適化しているAPIを提供しているわけではないので、過度なリクエストは控えてください。
#また、翻訳結果の品質は保証されません。翻訳速度についても、リクエストの内容やサーバーの状況によって大きく変動する可能性があります。あらかじめご了承ください。
payload = {"text": text, "from": lang, "to": target}
headers = {"Content-Type": "application/json"}

resp = requests.post(url, json=payload, headers=headers, timeout=20)
resp.raise_for_status()

data = resp.json()
translated = data.get("translation")

print("翻訳結果:", translated)