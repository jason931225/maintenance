# 재고 화면 실연결 근거

- **사용자 흐름:** 재고 운영자는 `/console/inventory`에서 품목명·SKU·IV 코드와 안전재고 부족 상태로 서버 목록을 필터링하고, 선택한 품목의 보관 위치·현재고·안전재고·출고 이력을 확인한다. 서버가 반환한 같은 지점의 작업 지시만 원천으로 선택해 milli-unit 수량의 출고를 기록한다.
- **계약:** 생성된 TypeScript client의 `GET /api/v1/inventory/items`, `GET /api/v1/inventory/items/{item_id}`, `GET/POST /api/v1/inventory/items/{item_id}/consumptions`, `GET /api/v1/work-orders`만 사용한다. 임의 `fetch`, 가짜 성공, 클라이언트 전용 출고 상태는 사용하지 않는다.
- **권한·경계:** 백엔드의 조직·지점/RLS 결정을 다시 구현하지 않는다. 현재 생성 계약의 `GET /api/v1/work-orders`에는 `branch_id` 질의 인자가 없으므로, 서버의 RLS 결과에서 선택 품목과 다른 지점 후보를 추가로 제거한다. 403과 잘못된 2xx 계약 응답은 빈 목록이 아니라 명시적인 오류 상태로 보이며, 세션 인카네이션·선택 epoch·취소 가능한 요청이 이전 세션/선택의 응답을 차단한다.
- **노출:** 이 화면은 개발 inventory에만 mount한다. `EXPOSED_SCREEN_KEYS`에는 포함하지 않아 ADR-0025의 운영 노출 권한을 변경하지 않는다.
