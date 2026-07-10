import React from 'react';
import { Linking, StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-video', () => {
  const React = require('react');
  const { View } = require('react-native');

  return {
    __esModule: true,
    default: (props: Record<string, unknown>) =>
      React.createElement(View, {
        ...props,
        accessibilityLabel: props.accessibilityLabel ?? 'video',
        accessible: true,
      }),
  };
});

import { CossLandingScreen } from '../CossLandingScreen';
import {
  cossHeroVideo,
  cossPages,
  cossSiteRoutes,
  cossSourceSitemapRoutes,
} from '../cossContent';

jest.setTimeout(30000);

describe('CossLandingScreen', () => {
  it('renders the COSS Korea landing hero and service sections', async () => {
    const { getByText, getAllByText } = await render(<CossLandingScreen />);

    expect(getByText('대한민국 대표 아웃소싱 기업 (주) 코스')).toBeTruthy();
    expect(getAllByText('물류도급').length).toBeGreaterThan(1);
    expect(getAllByText('생산도급').length).toBeGreaterThan(1);
    expect(getAllByText('통합시설관리').length).toBeGreaterThan(0);
    expect(getByText('COSS는 고객 곁에서')).toBeTruthy();
  });

  it('uses cosskorea.com and console.cosskorea.com for the migrated domains', async () => {
    const { getByText, getAllByText, queryByText } = await render(<CossLandingScreen />);

    expect(getByText('www.cosskorea.com')).toBeTruthy();
    expect(getAllByText('console.cosskorea.com').length).toBeGreaterThan(0);
    expect(queryByText('www.cossok.com')).toBeNull();
  });

  it('copies the source sitemap into selectable React Native pages', async () => {
    const { getByLabelText } = await render(<CossLandingScreen />);
    const copiedRoutes = cossPages.map(page => page.route);

    for (const route of cossSourceSitemapRoutes) {
      expect(copiedRoutes).toContain(route);
    }

    for (const page of cossPages) {
      expect(getByLabelText(`COSS page: ${page.title}`)).toBeTruthy();
    }
  });

  it('includes footer policy routes discovered from the live source site crawl', async () => {
    const { getByLabelText } = await render(<CossLandingScreen />);

    expect(getByLabelText('COSS page: 이용약관')).toBeTruthy();
    expect(getByLabelText('COSS page: 개인정보 취급방침')).toBeTruthy();
    expect(getByLabelText('COSS page: 이메일 무단수집 거부')).toBeTruthy();
    expect(getByLabelText('COSS page: 사이트맵')).toBeTruthy();
  });

  it('locks desktop/mobile scrolling to source fullpage frames', async () => {
    const { getByTestId } = await render(<CossLandingScreen />);
    const parallaxScroll = getByTestId('coss-parallax-scroll');

    expect(parallaxScroll.props.pagingEnabled).toBe(true);
    expect(parallaxScroll.props.disableIntervalMomentum).toBe(true);
    expect(parallaxScroll.props.decelerationRate).toBe('fast');
    expect(parallaxScroll.props.snapToAlignment).toBe('start');
    expect(parallaxScroll.props.showsVerticalScrollIndicator).toBe(false);
    expect(parallaxScroll.props.snapToOffsets).toHaveLength(5);
    expect(parallaxScroll.props.snapToOffsets[0]).toBe(0);
    expect(parallaxScroll.props.snapToOffsets[1]).toBeGreaterThan(0);
    expect(parallaxScroll.props.snapToOffsets[2]).toBe(
      parallaxScroll.props.snapToOffsets[1] * 2,
    );
    expect(parallaxScroll.props.snapToOffsets[3]).toBe(
      parallaxScroll.props.snapToOffsets[1] * 3,
    );
    expect(parallaxScroll.props.snapToOffsets[4]).toBeGreaterThan(
      parallaxScroll.props.snapToOffsets[3],
    );

    expect(getByTestId('fullpage-frame-hero')).toBeTruthy();
    expect(getByTestId('fullpage-frame-business')).toBeTruthy();
    expect(getByTestId('fullpage-frame-sustainability')).toBeTruthy();
    expect(getByTestId('fullpage-frame-contact')).toBeTruthy();
    expect(getByTestId('fullpage-frame-footer')).toBeTruthy();
  });

  it('includes the COSS source video, parallax scroll layer, and motion affordances', async () => {
    const { getByLabelText, getByTestId } = await render(<CossLandingScreen />);
    const heroVideo = getByLabelText('COSS source hero video');
    const parallaxScroll = getByTestId('coss-parallax-scroll');

    expect(heroVideo.props.source.uri).toBe(cossHeroVideo.legacyUri);
    expect(cossHeroVideo.targetUri).toBe(
      'https://www.cosskorea.com/html/_skin/files/coss_main_all_251229.mp4?ver=251224',
    );
    expect(cossHeroVideo.publicUri).toBe(cossHeroVideo.targetUri);
    expect(typeof parallaxScroll.props.onScroll).toBe('function');
    expect(getByTestId('fixed-video-parallax-layer')).toBeTruthy();
    expect(getByTestId('hero-parallax-copy')).toBeTruthy();
    expect(getByTestId('hero-reveal-motion')).toBeTruthy();
    expect(getByTestId('hero-video-atmosphere')).toBeTruthy();
    expect(getByTestId('recruit-motion-row')).toBeTruthy();
    expect(getByTestId('business-motion-row')).toBeTruthy();

    fireEvent.scroll(parallaxScroll, {
      nativeEvent: { contentOffset: { y: 920 } },
    });
  });

  it('exposes visible source-style hero progress controls', async () => {
    const { getByLabelText, getByTestId, getByText } = await render(
      <CossLandingScreen />,
    );
    const progressControls = getByTestId('hero-progress-controls');

    expect(StyleSheet.flatten(progressControls.props.style).opacity).not.toBe(0);
    expect(
      getByLabelText('Hero progress 03: 생산도급').props.accessibilityRole,
    ).toBe('button');

    fireEvent.press(getByLabelText('Hero progress 03: 생산도급'));

    await waitFor(() => {
      expect(getByTestId('active-hero-title').props.children).toBe('생산도급');
      expect(
        getByText(
          '다양한 제조 현장의 도급 운영 노하우로, 최적의 인력 운영과 공정 효율을 제공합니다.',
        ),
      ).toBeTruthy();
    });
  });

  it('opens the language selector and mobile sitemap menu', async () => {
    const { getByLabelText, getByText, getAllByText, queryByLabelText } =
      await render(<CossLandingScreen />);

    await act(async () => {
      getByLabelText('Language selector').props.onClick();
    });
    await waitFor(() => expect(getByText('KOR')).toBeTruthy());
    expect(getByText('ENG')).toBeTruthy();

    fireEvent.press(getByLabelText('Open COSS mobile menu'));
    await waitFor(() =>
      expect(getByLabelText('Close COSS mobile menu')).toBeTruthy(),
    );
    expect(getAllByText('가치와 비젼').length).toBeGreaterThan(0);
    expect(getAllByText('이메일 무단수집 거부').length).toBeGreaterThan(0);

    fireEvent.press(getByLabelText('Close COSS mobile menu'));
    await waitFor(() =>
      expect(queryByLabelText('Close COSS mobile menu')).toBeNull(),
    );
  });

  it('moves the recruit carousel with the same visible-center-card behavior as the source', async () => {
    const { getByLabelText, getByTestId } = await render(<CossLandingScreen />);

    expect(getByTestId('featured-recruit-title').props.children).toContain(
      'KGM 평택공장',
    );
    fireEvent.press(getByLabelText('Recruit next'));
    await waitFor(() =>
      expect(getByTestId('featured-recruit-title').props.children).toContain(
        '건설기계장비',
      ),
    );
    fireEvent.press(getByLabelText('Recruit previous'));
    await waitFor(() =>
      expect(getByTestId('featured-recruit-title').props.children).toContain(
        'KGM 평택공장',
      ),
    );
  });

  it('moves the business carousel and keeps business routes interactive', async () => {
    const { getByLabelText, getByTestId } = await render(<CossLandingScreen />);

    expect(getByTestId('active-business-title').props.children).toBe(
      '생산도급',
    );
    fireEvent.press(getByLabelText('Business next'));
    await waitFor(() => {
      expect(getByTestId('active-business-title').props.children).toBe(
        '물류도급',
      );
      expect(getByTestId('desktop-active-route').props.children).toBe(
        'cosskorea.com/business/logistics',
      );
    });
    fireEvent.press(getByLabelText('Business previous'));
    await waitFor(() =>
      expect(getByTestId('active-business-title').props.children).toBe(
        '생산도급',
      ),
    );
  });

  it('surfaces a compact desktop route dock with actionable public and console routes', async () => {
    const { getByLabelText, getByTestId } = await render(<CossLandingScreen />);
    const openUrlSpy = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined);
    const routeDock = getByTestId('desktop-route-dock');
    const activeRoute = getByTestId('desktop-active-route');

    expect(routeDock).toBeTruthy();
    expect(activeRoute.props.children).toBe('cosskorea.com/company/vision');
    expect(getByLabelText('공개 홈 열기').props.accessibilityRole).toBe('link');
    expect(getByLabelText('운영 콘솔 열기').props.accessibilityRole).toBe('link');

    expect(getByLabelText('데스크톱 사이트맵 경로: FAQ').props.accessibilityRole).toBe(
      'button',
    );
    expect(
      getByLabelText('데스크톱 사이트맵 경로: 개인정보 취급방침').props
        .accessibilityRole,
    ).toBe('button');
    expect(
      getByLabelText('공개 경로 열기: cosskorea.com/company/vision').props
        .accessibilityRole,
    ).toBe('link');

    fireEvent.press(getByLabelText('데스크톱 사이트맵 경로: FAQ'));
    await waitFor(() =>
      expect(activeRoute.props.children).toBe('cosskorea.com/contactus/faq'),
    );

    fireEvent.press(getByLabelText('운영 콘솔 열기'));
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://console.cosskorea.com/login',
    );
    openUrlSpy.mockRestore();
  });

  it('maps every fetched cossok.com route to cosskorea.com', async () => {
    const { getAllByText, queryByText } = await render(<CossLandingScreen />);

    for (const route of cossSiteRoutes) {
      expect(getAllByText(`cosskorea.com${route}`).length).toBeGreaterThan(0);
      expect(queryByText(`cossok.com${route}`)).toBeNull();
    }
  });

  it('keeps key source routes available in the desktop route dock', async () => {
    const { getByLabelText } = await render(<CossLandingScreen />);

    expect(getByLabelText('데스크톱 사이트맵 경로: 연혁').props.accessibilityRole).toBe(
      'button',
    );
    expect(getByLabelText('데스크톱 사이트맵 경로: FAQ').props.accessibilityRole).toBe(
      'button',
    );
    expect(
      getByLabelText('데스크톱 사이트맵 경로: 개인정보 취급방침').props
        .accessibilityRole,
    ).toBe('button');
  });
});
