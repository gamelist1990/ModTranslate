import requests

text = "hello"
lang = "en"
target = "ja"

url = "https://script.google.com/macros/s/AKfycbxPh_IjkSYpkfxHoGXVzK4oNQ2Vy0uRByGeNGA6ti3M7flAMCYkeJKuoBrALNCMImEi_g/exec"
payload = {"text": text, "from": lang, "to": target}
headers = {"Content-Type": "application/json"}

resp = requests.post(url, json=payload, headers=headers, timeout=20)
resp.raise_for_status()

data = resp.json()
translated = data.get("translation")

print("翻訳結果:", translated)